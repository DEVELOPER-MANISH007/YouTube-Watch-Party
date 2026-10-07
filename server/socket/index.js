const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Room = require("../models/Room");
const { ACTIONS, ROLES, canPerform, findParticipant } = require("../utils/roomAuth");
const { hashSessionToken } = require("../utils/sessionTokens");
const { effectiveTime, serializeRoom } = require("../utils/roomSerialization");

const playbackCache = new Map();
const persistenceTimers = new Map();
const playbackQueues = new Map();
const persistenceQueues = new Map();
const membershipQueues = new Map();
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function enqueueByKey(queues, key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  }).catch(() => {});
  return current;
}

function membershipKey(roomCode, userId) {
  return `${roomCode}:${userId}`;
}

function normalizeCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase().replace(/\s/g, "");
  return /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/.test(code) ? code : null;
}

function participantsFor(room) {
  return room.participants.filter((person) => person.isOnline).map(({ userId, username, role }) => ({ userId, username, role }));
}

function stateFor(roomCode, room) {
  if (!playbackCache.has(roomCode)) {
    playbackCache.set(roomCode, {
      videoId: room.currentVideoId || null,
      isPlaying: Boolean(room.isPlaying),
      currentTime: Math.max(0, room.currentTime || 0),
      updatedAt: new Date(room.playbackUpdatedAt || room.updatedAt || Date.now()).getTime(),
    });
  }
  return playbackCache.get(roomCode);
}

function snapshot(room, userId, state = stateFor(room.roomCode, room)) {
  const now = Date.now();
  return serializeRoom({
    ...room.toObject(),
    currentVideoId: state.videoId,
    isPlaying: state.isPlaying,
    currentTime: effectiveTime(state, now),
    playbackUpdatedAt: new Date(now),
  }, userId, now);
}

async function persistPlayback(roomCode, state) {
  const now = Date.now();
  state.currentTime = effectiveTime(state, now);
  state.updatedAt = now;
  await Room.updateOne({ roomCode }, {
    $set: {
      currentVideoId: state.videoId,
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackUpdatedAt: new Date(now),
    },
  });
}

function queuePlaybackPersistence(roomCode, state, immediate = false) {
  const existing = persistenceTimers.get(roomCode);
  if (existing) clearTimeout(existing);
  persistenceTimers.delete(roomCode);
  if (immediate) {
    void enqueueByKey(persistenceQueues, roomCode, () => persistPlayback(roomCode, { ...state }))
      .catch((error) => console.error("Could not persist playback state:", error.name || "Error"));
    return;
  }
  const timer = setTimeout(() => {
    persistenceTimers.delete(roomCode);
    void enqueueByKey(persistenceQueues, roomCode, () => persistPlayback(roomCode, { ...state }))
      .catch((error) => console.error("Could not persist playback state:", error.name || "Error"));
  }, 1200);
  persistenceTimers.set(roomCode, timer);
}

function replyError(socket, ack, code, message) {
  const error = { code, message };
  socket.emit("socket_error", error);
  if (typeof ack === "function") ack({ ok: false, error });
}

async function disconnectMember(io, socket, member) {
  if (!member || mongoose.connection.readyState !== 1) return;
  try {
    await enqueueByKey(membershipQueues, membershipKey(member.roomCode, member.userId), async () => {
      const hasActiveSocket = async () => {
        const roomSockets = await io.in(member.roomCode).fetchSockets();
        return roomSockets.some((candidate) => candidate.data.member?.roomCode === member.roomCode
          && candidate.data.member?.userId === member.userId);
      };
      if (await hasActiveSocket()) return;
      const room = await Room.findOne({ roomCode: member.roomCode }).select("+participants.sessionTokenHash");
      const participant = findParticipant(room, member.userId);
      if (!room || !participant || !participant.isOnline) return;

      // A reconnect queues its online update on the same key. Recheck after the
      // database read so a socket that appeared during this disconnect stays online.
      if (await hasActiveSocket()) return;
      participant.isOnline = false;
      await room.save();
      socket.to(member.roomCode).emit("user_left", {
        userId: participant.userId,
        participants: participantsFor(room),
      });
    });
  } catch (error) {
    console.error("Could not update room membership after disconnect:", error.name || "Error");
  }
  try {
    const remaining = await io.in(member.roomCode).fetchSockets();
    if (remaining.length === 0) {
      const timer = persistenceTimers.get(member.roomCode);
      if (timer) clearTimeout(timer);
      persistenceTimers.delete(member.roomCode);
      const state = playbackCache.get(member.roomCode);
      if (state) await enqueueByKey(persistenceQueues, member.roomCode, () => persistPlayback(member.roomCode, { ...state }));
      playbackCache.delete(member.roomCode);
    }
  } catch (error) {
    console.error("Could not finalize room state:", error.name || "Error");
  }
}

function initializeSocket(server, clientUrl) {
  const io = new Server(server, {
    cors: { origin: clientUrl, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    socket.on("join_room", async (payload, ack) => {
      try {
        if (mongoose.connection.readyState !== 1) return replyError(socket, ack, "DATABASE_UNAVAILABLE", "Room service is temporarily unavailable.");
        const roomCode = normalizeCode(payload?.roomCode);
        const token = payload?.sessionToken;
        if (!roomCode || typeof token !== "string" || token.length < 32 || token.length > 128) {
          return replyError(socket, ack, "INVALID_JOIN", "A valid room code and room session are required.");
        }
        const tokenHash = hashSessionToken(token);
        const room = await Room.findOne({ roomCode, "participants.sessionTokenHash": tokenHash }).select("+participants.sessionTokenHash");
        if (!room) return replyError(socket, ack, "ROOM_NOT_FOUND", "Room or room session not found. Join again with the room code.");
        const participant = room.participants.find((person) => person.sessionTokenHash === tokenHash);
        if (!participant) return replyError(socket, ack, "ROOM_NOT_FOUND", "Room session not found. Join again with the room code.");
        if (socket.data.member && socket.data.member.roomCode !== roomCode) {
          const previousMember = socket.data.member;
          socket.data.member = null;
          await socket.leave(previousMember.roomCode);
          await disconnectMember(io, socket, previousMember);
        }
        if (socket.data.member?.roomCode === roomCode && socket.data.member?.userId === participant.userId) {
          if (typeof ack === "function") ack({ ok: true, room: snapshot(room, participant.userId) });
          return;
        }

        const existingSockets = await io.in(roomCode).fetchSockets();
        for (const existingSocket of existingSockets) {
          if (existingSocket.data.member?.userId === participant.userId) {
            existingSocket.data.member = null;
            existingSocket.emit("session_replaced", { message: "This room session connected in another tab." });
            existingSocket.disconnect(true);
          }
        }
        const joined = await enqueueByKey(membershipQueues, membershipKey(roomCode, participant.userId), async () => {
          const currentRoom = await Room.findOne({ roomCode, "participants.sessionTokenHash": tokenHash })
            .select("+participants.sessionTokenHash");
          const currentParticipant = currentRoom?.participants.find((person) => person.sessionTokenHash === tokenHash);
          if (!currentRoom || !currentParticipant) return { error: ["ROOM_NOT_FOUND", "Room session not found. Join again with the room code."] };
          const nameInUse = currentRoom.participants.some((person) => person.userId !== currentParticipant.userId
            && person.isOnline && person.username.toLocaleLowerCase() === currentParticipant.username.toLocaleLowerCase());
          if (nameInUse) return { error: ["USERNAME_IN_USE", "That name is already being used by someone currently in this room."] };

          socket.data.member = { roomCode, userId: currentParticipant.userId };
          try {
            await socket.join(roomCode);
            currentParticipant.isOnline = true;
            await currentRoom.save();
          } catch (error) {
            socket.data.member = null;
            await socket.leave(roomCode);
            throw error;
          }
          return { room: currentRoom, participant: currentParticipant, state: snapshot(currentRoom, currentParticipant.userId) };
        });
        if (joined.error) return replyError(socket, ack, joined.error[0], joined.error[1]);
        const { participant: currentParticipant, state: roomState } = joined;
        socket.emit("sync_state", roomState);
        socket.to(roomCode).emit("user_joined", {
          participant: { userId: currentParticipant.userId, username: currentParticipant.username, role: currentParticipant.role },
          participants: roomState.participants,
        });
        if (typeof ack === "function") ack({ ok: true, room: roomState });
      } catch (error) {
        console.error("Socket room join failed:", error.name || "Error");
        replyError(socket, ack, "JOIN_FAILED", "Could not join this room. Please try again.");
      }
    });

    socket.on("leave_room", async (_payload, ack) => {
      const member = socket.data.member;
      if (!member) {
        if (typeof ack === "function") ack({ ok: true });
        return;
      }
      socket.data.member = null;
      await socket.leave(member.roomCode);
      await disconnectMember(io, socket, member);
      if (typeof ack === "function") ack({ ok: true });
    });

    for (const action of [ACTIONS.PLAY, ACTIONS.PAUSE, ACTIONS.SEEK, ACTIONS.CHANGE_VIDEO]) {
      socket.on(action, (payload, ack) => {
        const member = socket.data.member;
        if (mongoose.connection.readyState !== 1) return replyError(socket, ack, "DATABASE_UNAVAILABLE", "Room service is temporarily unavailable.");
        if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before controlling playback.");

        void enqueueByKey(playbackQueues, member.roomCode, async () => {
          try {
            // A queued action is valid only while its original socket membership remains active.
            if (socket.data.member?.roomCode !== member.roomCode || socket.data.member?.userId !== member.userId) {
              return replyError(socket, ack, "NOT_IN_ROOM", "You are no longer an active room participant.");
            }
            const room = await Room.findOne({ roomCode: member.roomCode });
            const actor = findParticipant(room, member.userId);
            if (!room || !actor || !actor.isOnline) return replyError(socket, ack, "NOT_IN_ROOM", "You are no longer an active room participant.");
            if (!canPerform(actor.role, action)) return replyError(socket, ack, "FORBIDDEN", "Your room role does not allow this action.");

            const state = stateFor(member.roomCode, room);
            const now = Date.now();
            if (action === ACTIONS.CHANGE_VIDEO) {
              if (!VIDEO_ID_PATTERN.test(payload?.videoId || "")) return replyError(socket, ack, "INVALID_VIDEO_ID", "Provide a valid YouTube video ID.");
              state.videoId = payload.videoId;
              state.isPlaying = false;
              state.currentTime = 0;
            } else if (action === ACTIONS.SEEK) {
              if (typeof payload?.time !== "number" || !Number.isFinite(payload.time) || payload.time < 0) {
                return replyError(socket, ack, "INVALID_SEEK", "Seek time must be a finite, non-negative number.");
              }
              state.currentTime = payload.time;
            } else {
              if (payload?.currentTime !== undefined && (typeof payload.currentTime !== "number" || !Number.isFinite(payload.currentTime) || payload.currentTime < 0)) {
                return replyError(socket, ack, "INVALID_SEEK", "Playback time must be a finite, non-negative number.");
              }
              state.currentTime = payload?.currentTime ?? effectiveTime(state, now);
              state.isPlaying = action === ACTIONS.PLAY;
            }
            state.updatedAt = now;
            queuePlaybackPersistence(member.roomCode, state, action !== ACTIONS.SEEK);
            const response = snapshot(room, member.userId, state);
            const { currentUser: _requester, ...sharedState } = response;
            io.to(member.roomCode).emit("sync_state", sharedState);
            if (typeof ack === "function") ack({ ok: true, room: response });
          } catch (error) {
            console.error(`Socket ${action} failed:`, error.name || "Error");
            replyError(socket, ack, "ACTION_FAILED", "The room could not apply that action.");
          }
        });
      });
    }

    socket.on("assign_role", async (payload, ack) => {
      try {
        const member = socket.data.member;
        if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before changing participant roles.");
        const room = await Room.findOne({ roomCode: member.roomCode }).select("+participants.sessionTokenHash");
        const actor = findParticipant(room, member.userId);
        if (!room || !actor || !actor.isOnline) return replyError(socket, ack, "NOT_IN_ROOM", "You are no longer an active room participant.");
        if (!canPerform(actor.role, ACTIONS.ASSIGN_ROLE)) return replyError(socket, ack, "FORBIDDEN", "Only the host can assign participant roles.");
        if (![ROLES.MODERATOR, ROLES.PARTICIPANT].includes(payload?.role)) return replyError(socket, ack, "INVALID_ROLE", "A participant can only be assigned Moderator or Participant.");
        const target = findParticipant(room, payload?.userId);
        if (!target || target.userId === room.hostId || target.role === ROLES.HOST) return replyError(socket, ack, "PARTICIPANT_NOT_FOUND", "That participant cannot be assigned a role.");
        target.role = payload.role;
        await room.save();
        const update = { participant: { userId: target.userId, username: target.username, role: target.role }, participants: participantsFor(room) };
        io.to(member.roomCode).emit("role_assigned", update);
        if (typeof ack === "function") ack({ ok: true, ...update });
      } catch (error) {
        console.error("Socket role assignment failed:", error.name || "Error");
        replyError(socket, ack, "ROLE_ASSIGN_FAILED", "Could not update that participant's role.");
      }
    });

    socket.on("remove_participant", async (payload, ack) => {
      try {
        const member = socket.data.member;
        if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before removing participants.");
        const room = await Room.findOne({ roomCode: member.roomCode }).select("+participants.sessionTokenHash");
        const actor = findParticipant(room, member.userId);
        if (!room || !actor || !actor.isOnline) return replyError(socket, ack, "NOT_IN_ROOM", "You are no longer an active room participant.");
        if (!canPerform(actor.role, ACTIONS.REMOVE_PARTICIPANT)) return replyError(socket, ack, "FORBIDDEN", "Only the host can remove participants.");
        const target = findParticipant(room, payload?.userId);
        if (!target || target.userId === room.hostId || target.role === ROLES.HOST) return replyError(socket, ack, "PARTICIPANT_NOT_FOUND", "The host cannot be removed from the room.");
        const removed = { userId: target.userId, username: target.username, role: target.role };
        const targetIndex = room.participants.findIndex((person) => person.userId === target.userId);
        room.participants.splice(targetIndex, 1);
        await room.save();
        const update = { ...removed, participants: participantsFor(room) };
        io.to(member.roomCode).emit("participant_removed", update);
        const connectedSockets = await io.in(member.roomCode).fetchSockets();
        for (const connectedSocket of connectedSockets) {
          if (connectedSocket.data.member?.userId === target.userId) {
            connectedSocket.data.member = null;
            setTimeout(() => connectedSocket.disconnect(true), 100);
          }
        }
        if (typeof ack === "function") ack({ ok: true, ...update });
      } catch (error) {
        console.error("Socket participant removal failed:", error.name || "Error");
        replyError(socket, ack, "REMOVE_FAILED", "Could not remove that participant.");
      }
    });

    socket.on("disconnect", () => {
      const member = socket.data.member;
      socket.data.member = null;
      void disconnectMember(io, socket, member);
    });
  });

  return io;
}

module.exports = initializeSocket;
