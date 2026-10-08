const { Server } = require("socket.io");
const { randomUUID } = require("node:crypto");
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
const pendingActionRequests = new Map();
const hostDisconnectTimers = new Map();
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PLAYBACK_ACTIONS = new Set([ACTIONS.PLAY, ACTIONS.PAUSE, ACTIONS.SEEK, ACTIONS.CHANGE_VIDEO]);
const MAX_PENDING_REQUESTS_PER_ROOM = 50;
const HOST_RECONNECT_GRACE_MS = 10000;

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

function clearHostDisconnectTimer(roomCode, userId) {
  const key = membershipKey(roomCode, userId);
  const timer = hostDisconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  hostDisconnectTimers.delete(key);
}

function withMembershipLocks(roomCode, userIds, operation) {
  const keys = [...new Set(userIds)].sort().map((userId) => membershipKey(roomCode, userId));
  const acquire = (index) => index === keys.length
    ? operation()
    : enqueueByKey(membershipQueues, keys[index], () => acquire(index + 1));
  return acquire(0);
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

function playbackActionError(action, payload) {
  if (!PLAYBACK_ACTIONS.has(action)) return { code: "INVALID_ACTION", message: "Choose a supported playback action." };
  if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    return { code: "INVALID_PAYLOAD", message: "The playback request payload is invalid." };
  }
  if (action === ACTIONS.CHANGE_VIDEO && !VIDEO_ID_PATTERN.test(payload?.videoId || "")) {
    return { code: "INVALID_VIDEO_ID", message: "Provide a valid YouTube video ID." };
  }
  if (action === ACTIONS.SEEK && (typeof payload?.time !== "number" || !Number.isFinite(payload.time) || payload.time < 0)) {
    return { code: "INVALID_SEEK", message: "Seek time must be a finite, non-negative number." };
  }
  if ([ACTIONS.PLAY, ACTIONS.PAUSE].includes(action) && payload?.currentTime !== undefined
    && (typeof payload.currentTime !== "number" || !Number.isFinite(payload.currentTime) || payload.currentTime < 0)) {
    return { code: "INVALID_SEEK", message: "Playback time must be a finite, non-negative number." };
  }
  return null;
}

function requestsFor(roomCode) {
  return [...(pendingActionRequests.get(roomCode)?.values() || [])].map((request) => ({
    requestId: request.requestId,
    userId: request.userId,
    username: request.username,
    action: request.action,
    payload: request.payload,
  }));
}

async function broadcastPendingRequests(io, roomCode) {
  const room = await Room.findOne({ roomCode, sessionEndedAt: null });
  const sockets = await io.in(roomCode).fetchSockets();
  const requests = room ? requestsFor(roomCode) : [];
  for (const recipient of sockets) {
    const member = recipient.data.member;
    const participant = member?.roomCode === roomCode ? findParticipant(room, member.userId) : null;
    if (participant?.isOnline && canPerform(participant.role, ACTIONS.PLAY)) {
      recipient.emit("pending_action_requests", requests);
    }
  }
}

function notifyRequestStatus(io, request, status) {
  const requester = io.sockets.sockets.get(request.socketId);
  if (requester?.connected && requester.data.member?.roomCode === request.roomCode
    && requester.data.member?.userId === request.userId) {
    requester.emit("action_request_status", { requestId: request.requestId, action: request.action, status });
  }
}

async function removeRequestsForUser(io, roomCode, userId, status) {
  const requests = pendingActionRequests.get(roomCode);
  if (!requests) return;
  for (const request of requests.values()) {
    if (request.userId === userId) {
      requests.delete(request.requestId);
      notifyRequestStatus(io, request, status);
    }
  }
  if (!requests.size) pendingActionRequests.delete(roomCode);
  await broadcastPendingRequests(io, roomCode);
}

async function clearRoomRequests(io, roomCode, status) {
  const requests = pendingActionRequests.get(roomCode);
  if (requests) {
    for (const request of requests.values()) notifyRequestStatus(io, request, status);
    pendingActionRequests.delete(roomCode);
  }
  await broadcastPendingRequests(io, roomCode);
}

function deferHostDisconnectEnd(io, member) {
  const key = membershipKey(member.roomCode, member.userId);
  clearHostDisconnectTimer(member.roomCode, member.userId);
  const timer = setTimeout(() => {
    void enqueueByKey(membershipQueues, key, async () => {
      if (hostDisconnectTimers.get(key) !== timer) return;
      hostDisconnectTimers.delete(key);
      const roomSockets = await io.in(member.roomCode).fetchSockets();
      if (roomSockets.some((candidate) => candidate.data.member?.roomCode === member.roomCode
        && candidate.data.member?.userId === member.userId)) return;

      await enqueueByKey(playbackQueues, member.roomCode, async () => {
        const activeRoom = await Room.findOne({
          roomCode: member.roomCode,
          hostId: member.userId,
          sessionEndedAt: null,
          participants: { $elemMatch: { userId: member.userId, role: ROLES.HOST, isOnline: true } },
        });
        const activeHost = findParticipant(activeRoom, member.userId);
        if (!activeRoom || !activeHost) return;
        const currentSockets = await io.in(member.roomCode).fetchSockets();
        if (currentSockets.some((candidate) => candidate.data.member?.roomCode === member.roomCode
          && candidate.data.member?.userId === member.userId)) return;

        activeRoom.sessionEndedAt = new Date();
        activeRoom.sessionEndReason = "host_disconnected";
        activeRoom.isPlaying = false;
        activeHost.isOnline = false;
        await activeRoom.save();
        const playbackTimer = persistenceTimers.get(member.roomCode);
        if (playbackTimer) clearTimeout(playbackTimer);
        persistenceTimers.delete(member.roomCode);
        const state = playbackCache.get(member.roomCode);
        if (state) { state.isPlaying = false; queuePlaybackPersistence(member.roomCode, state, true); }
        await clearRoomRequests(io, member.roomCode, "session_ended");
        io.to(member.roomCode).emit("session_ended", { reason: "host_disconnected" });
      });
    }).catch((error) => {
      console.error("Could not finalize disconnected Host session:", error.name || "Error");
    });
  }, HOST_RECONNECT_GRACE_MS);
  hostDisconnectTimers.set(key, timer);
}

async function applyPlaybackAction(io, roomCode, userId, action, payload, requesterSession = null) {
  const invalid = playbackActionError(action, payload);
  if (invalid) return { ok: false, error: invalid };
  const room = await Room.findOne({ roomCode, sessionEndedAt: null });
  const actor = findParticipant(room, userId);
  if (!room || !actor || !actor.isOnline) {
    return { ok: false, error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
  }
  if (!canPerform(actor.role, action)) {
    return { ok: false, error: { code: "FORBIDDEN", message: "Your room role does not allow this action." } };
  }
  if (requesterSession) {
    const requesterSocket = io.sockets.sockets.get(requesterSession.socketId);
    const requester = findParticipant(room, requesterSession.userId);
    if (!requesterSocket?.connected || requesterSocket.data.member?.roomCode !== roomCode
      || requesterSocket.data.member?.userId !== requesterSession.userId
      || !requester?.isOnline || requester.role !== ROLES.PARTICIPANT) {
      return { ok: false, error: { code: "STALE_REQUEST", message: "The requester is no longer an active Participant." } };
    }
  }

  const state = stateFor(roomCode, room);
  const now = Date.now();
  if (action === ACTIONS.CHANGE_VIDEO) {
    state.videoId = payload.videoId;
    state.isPlaying = false;
    state.currentTime = 0;
  } else if (action === ACTIONS.SEEK) {
    state.currentTime = payload.time;
  } else {
    state.currentTime = payload?.currentTime ?? effectiveTime(state, now);
    state.isPlaying = action === ACTIONS.PLAY;
  }
  state.updatedAt = now;
  queuePlaybackPersistence(roomCode, state, action !== ACTIONS.SEEK);
  const response = snapshot(room, userId, state);
  const { currentUser: _requester, ...sharedState } = response;
  io.to(roomCode).emit("sync_state", sharedState);
  return { ok: true, room: response };
}

function handlePlaybackRequest(socket, io, action, payload, ack) {
  const member = socket.data.member;
  if (mongoose.connection.readyState !== 1) return replyError(socket, ack, "DATABASE_UNAVAILABLE", "Room service is temporarily unavailable.");
  if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before controlling playback.");
  void enqueueByKey(playbackQueues, member.roomCode, async () => {
    if (socket.data.member?.roomCode !== member.roomCode || socket.data.member?.userId !== member.userId) {
      return replyError(socket, ack, "NOT_IN_ROOM", "You are no longer an active room participant.");
    }
    try {
      const result = await applyPlaybackAction(io, member.roomCode, member.userId, action, payload);
      if (!result.ok) return replyError(socket, ack, result.error.code, result.error.message);
      if (typeof ack === "function") ack({ ok: true, room: result.room });
    } catch (error) {
      console.error(`Socket ${action} failed:`, error.name || "Error");
      replyError(socket, ack, "ACTION_FAILED", "The room could not apply that action.");
    }
  });
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
      if (room.sessionEndedAt) {
        participant.isOnline = false;
        await room.save();
        return;
      }
      if (room.hostId === participant.userId && participant.role === ROLES.HOST) {
        deferHostDisconnectEnd(io, member);
        return;
      }
      participant.isOnline = false;
      await room.save();
      await enqueueByKey(playbackQueues, member.roomCode, () => removeRequestsForUser(io, member.roomCode, member.userId, "cancelled"));
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

async function endSession(io, roomCode, userId) {
  return enqueueByKey(playbackQueues, roomCode, async () => {
    const room = await Room.findOneAndUpdate({
      roomCode,
      hostId: userId,
      sessionEndedAt: null,
      participants: { $elemMatch: { userId, role: ROLES.HOST, isOnline: true } },
    }, { $set: { sessionEndedAt: new Date(), sessionEndReason: "host_ended", isPlaying: false } }, { new: true });
    if (!room) {
      return { ok: false, error: { code: "FORBIDDEN", message: "Only the current Host can end this session." } };
    }
    const timer = persistenceTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    persistenceTimers.delete(roomCode);
    const state = playbackCache.get(roomCode);
    if (state) { state.isPlaying = false; queuePlaybackPersistence(roomCode, state, true); }
    await clearRoomRequests(io, roomCode, "session_ended");
    io.to(roomCode).emit("session_ended", { reason: "host_ended" });
    return { ok: true };
  });
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
        if (room.sessionEndedAt) return replyError(socket, ack, "SESSION_ENDED", "This watch party session has ended.");
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
          if (currentRoom.sessionEndedAt) return { error: ["SESSION_ENDED", "This watch party session has ended."] };
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
          // Preserve the reconnect grace timer until room membership has been
          // persisted and the replacement socket has joined successfully.
          clearHostDisconnectTimer(roomCode, currentParticipant.userId);
          return { room: currentRoom, participant: currentParticipant, state: snapshot(currentRoom, currentParticipant.userId) };
        });
        if (joined.error) return replyError(socket, ack, joined.error[0], joined.error[1]);
        const { participant: currentParticipant, state: roomState } = joined;
        socket.emit("sync_state", roomState);
        socket.to(roomCode).emit("user_joined", {
          participant: { userId: currentParticipant.userId, username: currentParticipant.username, role: currentParticipant.role },
          participants: roomState.participants,
        });
        await broadcastPendingRequests(io, roomCode);
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
      const room = await Room.findOne({ roomCode: member.roomCode, hostId: member.userId });
      if (room && findParticipant(room, member.userId)?.role === ROLES.HOST) {
        return replyError(socket, ack, "HOST_TRANSFER_REQUIRED", "Choose a new Host or end the session before leaving.");
      }
      socket.data.member = null;
      await socket.leave(member.roomCode);
      await disconnectMember(io, socket, member);
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("end_session", async (_payload, ack) => {
      const member = socket.data.member;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before ending its session.");
      try {
        const result = await endSession(io, member.roomCode, member.userId);
        if (!result.ok) return replyError(socket, ack, result.error.code, result.error.message);
        socket.data.member = null;
        await socket.leave(member.roomCode);
        if (typeof ack === "function") ack({ ok: true });
      } catch (error) {
        console.error("Could not end room session:", error.name || "Error");
        replyError(socket, ack, "END_SESSION_FAILED", "Could not end this watch party session.");
      }
    });

    socket.on("request_action", async (payload, ack) => {
      const member = socket.data.member;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before requesting a playback change.");
      if (mongoose.connection.readyState !== 1) return replyError(socket, ack, "DATABASE_UNAVAILABLE", "Room service is temporarily unavailable.");
      const invalid = playbackActionError(payload?.action, payload?.payload);
      if (invalid) return replyError(socket, ack, invalid.code, invalid.message);

      try {
        const result = await enqueueByKey(playbackQueues, member.roomCode, async () => {
          if (socket.data.member?.roomCode !== member.roomCode || socket.data.member?.userId !== member.userId) {
            return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          }
          const room = await Room.findOne({ roomCode: member.roomCode, sessionEndedAt: null });
          const participant = findParticipant(room, member.userId);
          if (!room || !participant?.isOnline) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          if (participant.role !== ROLES.PARTICIPANT) {
            return { error: { code: "FORBIDDEN", message: "Only Participants can request playback changes." } };
          }
          let requests = pendingActionRequests.get(member.roomCode);
          if (!requests) {
            requests = new Map();
            pendingActionRequests.set(member.roomCode, requests);
          }
          if (requests.size >= MAX_PENDING_REQUESTS_PER_ROOM) {
            return { error: { code: "REQUEST_LIMIT", message: "There are too many pending requests. Try again later." } };
          }
          const request = {
            requestId: randomUUID(), roomCode: member.roomCode, userId: member.userId,
            username: participant.username, socketId: socket.id, action: payload.action,
            payload: payload.payload ? { ...payload.payload } : {},
          };
          requests.set(request.requestId, request);
          await broadcastPendingRequests(io, member.roomCode);
          socket.emit("action_request_status", { requestId: request.requestId, action: request.action, status: "pending" });
          return { requestId: request.requestId };
        });
        if (result.error) return replyError(socket, ack, result.error.code, result.error.message);
        if (typeof ack === "function") ack({ ok: true, requestId: result.requestId });
      } catch (error) {
        console.error("Could not create playback request:", error.name || "Error");
        replyError(socket, ack, "REQUEST_FAILED", "Could not send this playback request.");
      }
    });

    socket.on("resolve_action_request", async (payload, ack) => {
      const member = socket.data.member;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before resolving playback requests.");
      if (!payload || typeof payload.requestId !== "string" || !["approve", "reject"].includes(payload.decision)) {
        return replyError(socket, ack, "INVALID_REQUEST", "Choose a valid request and approval decision.");
      }
      try {
        const result = await enqueueByKey(playbackQueues, member.roomCode, async () => {
          if (socket.data.member?.roomCode !== member.roomCode || socket.data.member?.userId !== member.userId) {
            return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          }
          const room = await Room.findOne({ roomCode: member.roomCode, sessionEndedAt: null });
          const actor = findParticipant(room, member.userId);
          if (!room || !actor?.isOnline) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          if (!canPerform(actor.role, ACTIONS.PLAY)) {
            return { error: { code: "FORBIDDEN", message: "Only the Host or a Moderator can resolve playback requests." } };
          }
          const requests = pendingActionRequests.get(member.roomCode);
          const request = requests?.get(payload.requestId);
          if (!request) return { error: { code: "STALE_REQUEST", message: "This request is no longer pending." } };
          if (request.userId === member.userId) {
            return { error: { code: "FORBIDDEN", message: "You cannot resolve your own request." } };
          }
          const requesterSocket = io.sockets.sockets.get(request.socketId);
          const requester = findParticipant(room, request.userId);
          if (!requesterSocket?.connected || requesterSocket.data.member?.roomCode !== member.roomCode
            || requesterSocket.data.member?.userId !== request.userId
            || !requester?.isOnline || requester.role !== ROLES.PARTICIPANT) {
            requests.delete(request.requestId);
            if (!requests.size) pendingActionRequests.delete(member.roomCode);
            notifyRequestStatus(io, request, "cancelled");
            await broadcastPendingRequests(io, member.roomCode);
            return { error: { code: "STALE_REQUEST", message: "The requester is no longer an active Participant." } };
          }

          if (payload.decision === "reject") {
            requests.delete(request.requestId);
            if (!requests.size) pendingActionRequests.delete(member.roomCode);
            notifyRequestStatus(io, request, "rejected");
            await broadcastPendingRequests(io, member.roomCode);
            return { requestId: request.requestId, decision: "reject" };
          }

          const applied = await applyPlaybackAction(io, member.roomCode, member.userId, request.action, request.payload, request);
          requests.delete(request.requestId);
          if (!requests.size) pendingActionRequests.delete(member.roomCode);
          if (!applied.ok) {
            notifyRequestStatus(io, request, "cancelled");
            await broadcastPendingRequests(io, member.roomCode);
            return { error: applied.error };
          }
          notifyRequestStatus(io, request, "approved");
          await broadcastPendingRequests(io, member.roomCode);
          return { requestId: request.requestId, decision: "approve" };
        });
        if (result.error) return replyError(socket, ack, result.error.code, result.error.message);
        if (typeof ack === "function") ack({ ok: true, ...result });
      } catch (error) {
        console.error("Could not resolve playback request:", error.name || "Error");
        replyError(socket, ack, "REQUEST_RESOLUTION_FAILED", "Could not resolve this playback request.");
      }
    });

    socket.on("transfer_host", async (payload, ack) => {
      const member = socket.data.member;
      const targetUserId = payload?.userId;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before transferring Host.");
      if (typeof targetUserId !== "string" || !targetUserId || targetUserId === member.userId) {
        return replyError(socket, ack, "INVALID_HOST", "Select an eligible participant to become Host.");
      }
      try {
        const transferred = await withMembershipLocks(member.roomCode, [member.userId, targetUserId], () =>
          enqueueByKey(playbackQueues, member.roomCode, async () => {
          const current = await Room.findOne({ roomCode: member.roomCode, hostId: member.userId, sessionEndedAt: null })
            .select("+participants.sessionTokenHash");
          const actor = findParticipant(current, member.userId);
          const target = findParticipant(current, targetUserId);
          if (!current || !actor || actor.role !== ROLES.HOST || !actor.isOnline) return null;
          if (!target || !target.isOnline || ![ROLES.MODERATOR, ROLES.PARTICIPANT].includes(target.role)) return false;
          const connected = await io.in(member.roomCode).fetchSockets();
          if (!connected.some((candidate) => candidate.data.member?.roomCode === member.roomCode
            && candidate.data.member?.userId === targetUserId)) return false;
          const updated = await Room.findOneAndUpdate({
            _id: current._id,
            hostId: member.userId,
            sessionEndedAt: null,
            participants: { $all: [
              { $elemMatch: { userId: member.userId, role: ROLES.HOST, isOnline: true } },
              { $elemMatch: { userId: targetUserId, role: { $in: [ROLES.MODERATOR, ROLES.PARTICIPANT] }, isOnline: true } },
            ] },
          }, {
            $set: {
              hostId: targetUserId,
              "participants.$[oldHost].role": ROLES.PARTICIPANT,
              "participants.$[oldHost].isOnline": false,
              "participants.$[newHost].role": ROLES.HOST,
            },
          }, {
            arrayFilters: [{ "oldHost.userId": member.userId }, { "newHost.userId": targetUserId }],
            new: true,
          }).select("+participants.sessionTokenHash");
          return updated || false;
          }),
        );
        if (!transferred) {
          const code = transferred === null ? "FORBIDDEN" : "HOST_NOT_ELIGIBLE";
          const message = transferred === null ? "Only the current Host can transfer Host." : "That participant is no longer available to become Host. Choose someone else.";
          return replyError(socket, ack, code, message);
        }
        const participants = participantsFor(transferred);
        const newHost = participants.find((item) => item.userId === targetUserId);
        io.to(member.roomCode).emit("role_assigned", { participant: newHost, participants });
        await removeRequestsForUser(io, member.roomCode, targetUserId, "cancelled");
        await broadcastPendingRequests(io, member.roomCode);
        socket.data.member = null;
        await socket.leave(member.roomCode);
        if (typeof ack === "function") ack({ ok: true, participants });
      } catch (error) {
        console.error("Host transfer failed:", error.name || "Error");
        replyError(socket, ack, "HOST_TRANSFER_FAILED", "Could not transfer Host. Please try again.");
      }
    });

    socket.on("play", (payload, ack) => handlePlaybackRequest(socket, io, ACTIONS.PLAY, payload, ack));
    socket.on("pause", (payload, ack) => handlePlaybackRequest(socket, io, ACTIONS.PAUSE, payload, ack));
    socket.on("seek", (payload, ack) => handlePlaybackRequest(socket, io, ACTIONS.SEEK, payload, ack));
    socket.on("change_video", (payload, ack) => handlePlaybackRequest(socket, io, ACTIONS.CHANGE_VIDEO, payload, ack));

    socket.on("assign_role", async (payload, ack) => {
      const member = socket.data.member;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before changing participant roles.");
      try {
        const result = await enqueueByKey(playbackQueues, member.roomCode, async () => {
          if (socket.data.member?.userId !== member.userId) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          const room = await Room.findOne({ roomCode: member.roomCode, sessionEndedAt: null }).select("+participants.sessionTokenHash");
          const actor = findParticipant(room, member.userId);
          if (!room || !actor || !actor.isOnline) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          if (!canPerform(actor.role, ACTIONS.ASSIGN_ROLE)) return { error: { code: "FORBIDDEN", message: "Only the host can assign participant roles." } };
          if (![ROLES.MODERATOR, ROLES.PARTICIPANT].includes(payload?.role)) return { error: { code: "INVALID_ROLE", message: "A participant can only be assigned Moderator or Participant." } };
          const target = findParticipant(room, payload?.userId);
          if (!target || target.userId === room.hostId || target.role === ROLES.HOST) return { error: { code: "PARTICIPANT_NOT_FOUND", message: "That participant cannot be assigned a role." } };
          target.role = payload.role;
          await room.save();
          const update = { participant: { userId: target.userId, username: target.username, role: target.role }, participants: participantsFor(room) };
          io.to(member.roomCode).emit("role_assigned", update);
          if (target.role !== ROLES.PARTICIPANT) await removeRequestsForUser(io, member.roomCode, target.userId, "cancelled");
          else await broadcastPendingRequests(io, member.roomCode);
          return { update };
        });
        if (result.error) return replyError(socket, ack, result.error.code, result.error.message);
        if (typeof ack === "function") ack({ ok: true, ...result.update });
      } catch (error) {
        console.error("Socket role assignment failed:", error.name || "Error");
        replyError(socket, ack, "ROLE_ASSIGN_FAILED", "Could not update that participant's role.");
      }
    });

    socket.on("remove_participant", async (payload, ack) => {
      const member = socket.data.member;
      if (!member) return replyError(socket, ack, "NOT_IN_ROOM", "Join a room before removing participants.");
      try {
        const result = await enqueueByKey(playbackQueues, member.roomCode, async () => {
          if (socket.data.member?.userId !== member.userId) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          const room = await Room.findOne({ roomCode: member.roomCode, sessionEndedAt: null }).select("+participants.sessionTokenHash");
          const actor = findParticipant(room, member.userId);
          if (!room || !actor || !actor.isOnline) return { error: { code: "NOT_IN_ROOM", message: "You are no longer an active room participant." } };
          if (!canPerform(actor.role, ACTIONS.REMOVE_PARTICIPANT)) return { error: { code: "FORBIDDEN", message: "Only the host can remove participants." } };
          const target = findParticipant(room, payload?.userId);
          if (!target || target.userId === room.hostId || target.role === ROLES.HOST) return { error: { code: "PARTICIPANT_NOT_FOUND", message: "The host cannot be removed from the room." } };
          const removed = { userId: target.userId, username: target.username, role: target.role };
          const targetIndex = room.participants.findIndex((person) => person.userId === target.userId);
          room.participants.splice(targetIndex, 1);
          await room.save();
          const update = { ...removed, participants: participantsFor(room) };
          io.to(member.roomCode).emit("participant_removed", update);
          await removeRequestsForUser(io, member.roomCode, target.userId, "cancelled");
          const connectedSockets = await io.in(member.roomCode).fetchSockets();
          for (const connectedSocket of connectedSockets) {
            if (connectedSocket.data.member?.userId === target.userId) {
              connectedSocket.data.member = null;
              setTimeout(() => connectedSocket.disconnect(true), 100);
            }
          }
          return { update };
        });
        if (result.error) return replyError(socket, ack, result.error.code, result.error.message);
        if (typeof ack === "function") ack({ ok: true, ...result.update });
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
