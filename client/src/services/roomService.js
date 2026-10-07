import { extractVideoId } from "../utils/youtube.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
const sessionKey = (roomCode) => `watchparty.session.${roomCode.toUpperCase()}`;

async function request(path, options = {}) {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: body.error?.message || "The room service could not complete that request." };
    return { ok: true, ...body };
  } catch {
    return { ok: false, error: "Could not reach the room service. Check that the server is running and try again." };
  }
}

function saveSession(room, sessionToken) {
  localStorage.setItem(sessionKey(room.roomCode), sessionToken);
  return { ...room, sessionToken };
}

export async function createRoom(username, videoUrl) {
  const videoId = videoUrl ? extractVideoId(videoUrl) : null;
  if (videoUrl && !videoId) return { ok: false, error: "Enter a valid YouTube video link or video ID." };
  const result = await request("/api/rooms", { method: "POST", body: JSON.stringify({ username: username.trim(), videoId }) });
  if (!result.ok) return result;
  return { ok: true, room: saveSession(result.room, result.sessionToken) };
}

export async function joinRoom(username, roomCode) {
  const code = roomCode.trim().toUpperCase().replace(/\s/g, "");
  const result = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: "POST", body: JSON.stringify({ username: username.trim() }),
  });
  if (!result.ok) return result;
  return { ok: true, room: saveSession(result.room, result.sessionToken) };
}

export async function getRoom(roomCode) {
  const code = roomCode.toUpperCase();
  const sessionToken = localStorage.getItem(sessionKey(code));
  const result = await request(`/api/rooms/${encodeURIComponent(code)}`, {
    headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
  });
  if (!result.ok) return result;
  return { ok: true, room: { ...result.room, ...(sessionToken ? { sessionToken } : {}) } };
}

export function clearRoomSession(roomCode) {
  localStorage.removeItem(sessionKey(roomCode));
}
