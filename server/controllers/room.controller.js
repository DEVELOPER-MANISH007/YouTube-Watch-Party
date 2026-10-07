const { randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const Room = require("../models/Room");
const { ROLES } = require("../utils/roomAuth");
const { createSession, hashSessionToken } = require("../utils/sessionTokens");
const { serializeRoom } = require("../utils/roomSerialization");

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function validateUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim();
  return username.length > 0 && username.length <= 32 ? username : null;
}

function normalizeRoomCode(value) {
  if (typeof value !== "string") return null;
  const roomCode = value.trim().toUpperCase().replace(/\s/g, "");
  return /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/.test(roomCode) ? roomCode : null;
}

function validVideoId(value) {
  return value === null || value === undefined || (typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value));
}

function databaseReady(response) {
  if (mongoose.connection.readyState === 1) return true;
  fail(response, 503, "DATABASE_UNAVAILABLE", "Rooms are temporarily unavailable. Please try again shortly.");
  return false;
}

async function createRoom(request, response) {
  if (!databaseReady(response)) return;
  const username = validateUsername(request.body?.username);
  if (!username) return fail(response, 400, "INVALID_USERNAME", "Enter a name between 1 and 32 characters.");
  const videoId = request.body?.videoId ?? null;
  if (!validVideoId(videoId)) return fail(response, 400, "INVALID_VIDEO_ID", "Enter a valid YouTube video ID.");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = randomBytes(5).toString("hex").toUpperCase().replace(/^(.{5})(.*)$/, "$1-$2");
    const session = createSession();
    const room = new Room({
      roomCode,
      hostId: session.userId,
      currentVideoId: videoId,
      participants: [{ userId: session.userId, username, role: ROLES.HOST, sessionTokenHash: session.tokenHash, isOnline: true }],
    });
    try {
      await room.save();
      return response.status(201).json({ room: serializeRoom(room, session.userId), sessionToken: session.token });
    } catch (error) {
      if (error?.code === 11000 && attempt < 4) continue;
      if (error?.name === "ValidationError") return fail(response, 400, "INVALID_ROOM", "The room could not be created with those details.");
      throw error;
    }
  }
  return fail(response, 503, "ROOM_CODE_UNAVAILABLE", "Could not reserve a room code. Please try again.");
}

async function joinRoom(request, response) {
  if (!databaseReady(response)) return;
  const roomCode = normalizeRoomCode(request.params.roomCode);
  if (!roomCode) return fail(response, 400, "INVALID_ROOM_CODE", "Enter a valid room code.");
  const username = validateUsername(request.body?.username);
  if (!username) return fail(response, 400, "INVALID_USERNAME", "Enter a name between 1 and 32 characters.");
  const room = await Room.findOne({ roomCode }).select("+participants.sessionTokenHash");
  if (!room) return fail(response, 404, "ROOM_NOT_FOUND", "Room not found. Check the code with your host.");
  const duplicate = room.participants.some((person) => person.isOnline
    && person.username.toLocaleLowerCase() === username.toLocaleLowerCase());
  if (duplicate) return fail(response, 409, "USERNAME_IN_USE", "That name is already being used by someone currently in this room.");

  const session = createSession();
  room.participants.push({ userId: session.userId, username, role: ROLES.PARTICIPANT, sessionTokenHash: session.tokenHash, isOnline: false });
  await room.save();
  return response.status(201).json({ room: serializeRoom(room, session.userId), sessionToken: session.token });
}

async function getRoom(request, response) {
  if (!databaseReady(response)) return;
  const roomCode = normalizeRoomCode(request.params.roomCode);
  if (!roomCode) return fail(response, 400, "INVALID_ROOM_CODE", "Enter a valid room code.");
  const room = await Room.findOne({ roomCode }).select("+participants.sessionTokenHash");
  if (!room) return fail(response, 404, "ROOM_NOT_FOUND", "Room not found. Check the code with your host.");
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const tokenHash = token ? hashSessionToken(token) : null;
  const currentUser = tokenHash && room.participants.find((person) => person.sessionTokenHash === tokenHash);
  return response.json({ room: serializeRoom(room, currentUser?.userId || null) });
}

module.exports = { createRoom, joinRoom, getRoom, normalizeRoomCode, validateUsername };
