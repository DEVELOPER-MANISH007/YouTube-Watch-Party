import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
let activeSocket = null;

export function connectToRoom({ roomCode, userId, sessionToken, onSyncState, onUserJoined, onUserLeft, onRoleAssigned, onParticipantRemoved, onError, onRemoved }) {
  if (activeSocket) activeSocket.disconnect();
  const socket = io(API_URL, { autoConnect: false, transports: ["websocket", "polling"] });
  activeSocket = socket;

  socket.on("sync_state", onSyncState);
  socket.on("user_joined", onUserJoined);
  socket.on("user_left", onUserLeft);
  socket.on("role_assigned", onRoleAssigned);
  socket.on("participant_removed", (payload) => {
    onParticipantRemoved?.(payload);
    if (payload.userId === userId) onRemoved?.(payload);
  });
  socket.on("connect_error", () => onError?.({ message: "Could not connect to the room server. Retrying…" }));
  socket.on("session_replaced", (payload) => onRemoved?.(payload));

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      if (activeSocket === socket) activeSocket = null;
      reject(new Error(error?.message || "Could not join the room."));
    };
    socket.on("connect", () => {
      socket.timeout(8000).emit("join_room", { roomCode, sessionToken }, (timeoutError, result) => {
        if (timeoutError) return fail({ message: "The room server did not respond. Please try again." });
        if (!result?.ok) return fail(result?.error);
        if (!settled) { settled = true; resolve(result.room); }
      });
    });
    socket.connect();
  });
}

export function emitRoomAction(event, payload) {
  if (!activeSocket?.connected) return Promise.reject(new Error("You are not connected to the room."));
  return new Promise((resolve, reject) => {
    activeSocket.timeout(8000).emit(event, payload, (timeoutError, result) => {
      if (timeoutError) return reject(new Error("The room server did not respond. Please try again."));
      if (!result?.ok) return reject(new Error(result?.error?.message || "The room could not complete that action."));
      resolve(result);
    });
  });
}

export function leaveRoom() {
  const socket = activeSocket;
  if (!socket) return Promise.resolve();
  return new Promise((resolve) => {
    if (!socket.connected) {
      socket.disconnect();
      if (activeSocket === socket) activeSocket = null;
      resolve();
      return;
    }
    socket.timeout(2500).emit("leave_room", {}, () => {
      socket.disconnect();
      if (activeSocket === socket) activeSocket = null;
      resolve();
    });
  });
}

export function disconnectSocket() {
  activeSocket?.disconnect();
  activeSocket = null;
}
