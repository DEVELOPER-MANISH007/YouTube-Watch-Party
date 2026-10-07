const assert = require("node:assert/strict");
const path = require("node:path");
const clientRoot = path.resolve(__dirname, "..");
const serverRoot = path.resolve(clientRoot, "..", "server");
require(path.join(serverRoot, "node_modules", "dotenv")).config({ path: path.join(serverRoot, ".env") });
const mongoose = require(path.join(serverRoot, "node_modules", "mongoose"));
const Room = require(path.join(serverRoot, "models", "Room.js"));
const { io } = require("socket.io-client");

const API = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 5000}`;
const sockets = [];
let testRoomCode;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextEvent(socket, name, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Timed out waiting for Socket.IO event: ${name}`));
    }, timeout);
    const listener = (value) => { clearTimeout(timer); resolve(value); };
    socket.once(name, listener);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(6000).emit(event, payload, (timeoutError, result) => {
      if (timeoutError) reject(timeoutError);
      else resolve(result);
    });
  });
}

async function request(pathname, body, token) {
  const response = await fetch(`${API}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function connectMember(roomCode, sessionToken) {
  const socket = io(API, { autoConnect: false, transports: ["websocket"] });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Socket.IO server.")), 6000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });
  const syncPromise = nextEvent(socket, "sync_state");
  const result = await emitAck(socket, "join_room", { roomCode, sessionToken });
  assert.equal(result.ok, true, result.error?.message || "Socket join failed.");
  return { socket, initialSync: await syncPromise };
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required in server/.env for the realtime verification.");
  await mongoose.connect(process.env.MONGODB_URI);

  const invalidCreate = await request("/api/rooms", { username: "  ", videoId: null });
  assert.equal(invalidCreate.status, 400, "Server must reject a missing username.");
  const missingRoom = await request("/api/rooms/NOPE-1234");
  assert.equal(missingRoom.status, 404, "Room lookup must reject an unknown room code.");
  const created = await request("/api/rooms", { username: "Realtime Host", videoId: "dQw4w9WgXcQ" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  testRoomCode = created.body.room.roomCode;
  assert.match(testRoomCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/, "Room codes must be generated in the expected format.");
  assert.equal(created.body.room.currentUser.role, "host", "Room creator must be Host.");
  const host = await connectMember(testRoomCode, created.body.sessionToken);
  assert.equal(host.initialSync.currentUser.role, "host");
  assert.equal(host.initialSync.participants.length, 1);

  const firstJoin = await request(`/api/rooms/${testRoomCode}/join`, { username: "Realtime Guest" });
  assert.equal(firstJoin.status, 201, JSON.stringify(firstJoin.body));
  const firstJoinedNotice = nextEvent(host.socket, "user_joined");
  let guest = await connectMember(testRoomCode, firstJoin.body.sessionToken);
  assert.equal(guest.initialSync.currentUser.role, "participant");
  assert.equal((await firstJoinedNotice).participants.length, 2);
  const duplicateName = await request(`/api/rooms/${testRoomCode}/join`, { username: "Realtime Host" });
  assert.equal(duplicateName.status, 409, "Room join must reject a duplicate active username.");

  for (const [event, payload] of [
    ["play", { currentTime: 12 }], ["pause", { currentTime: 12 }], ["seek", { time: 12 }],
    ["change_video", { videoId: "M7lc1UVf-VE" }],
    ["assign_role", { userId: host.initialSync.currentUser.userId, role: "moderator" }],
    ["remove_participant", { userId: host.initialSync.currentUser.userId }],
  ]) {
    const denied = await emitAck(guest.socket, event, payload);
    assert.equal(denied.ok, false, `Participant must not be able to ${event}.`);
    assert.equal(denied.error.code, "FORBIDDEN", `Participant ${event} should be rejected by server authorization.`);
  }

  const hostRoleUpdate = nextEvent(host.socket, "role_assigned");
  const guestRoleUpdate = nextEvent(guest.socket, "role_assigned");
  const promotion = await emitAck(host.socket, "assign_role", { userId: guest.initialSync.currentUser.userId, role: "moderator" });
  assert.equal(promotion.ok, true);
  assert.equal((await hostRoleUpdate).participant.role, "moderator");
  await guestRoleUpdate;
  const hostRoleAttempt = await emitAck(host.socket, "assign_role", { userId: host.initialSync.currentUser.userId, role: "host" });
  assert.equal(hostRoleAttempt.ok, false, "Host role must not be assignable to create a second host.");
  assert.equal(hostRoleAttempt.error.code, "INVALID_ROLE");
  const modRoleAttempt = await emitAck(guest.socket, "assign_role", { userId: host.initialSync.currentUser.userId, role: "participant" });
  assert.equal(modRoleAttempt.ok, false); assert.equal(modRoleAttempt.error.code, "FORBIDDEN");
  const modRemoveAttempt = await emitAck(guest.socket, "remove_participant", { userId: host.initialSync.currentUser.userId });
  assert.equal(modRemoveAttempt.ok, false); assert.equal(modRemoveAttempt.error.code, "FORBIDDEN");

  // A disconnect immediately followed by a reconnect must leave the participant online.
  const guestUserId = guest.initialSync.currentUser.userId;
  guest.socket.disconnect();
  guest = await connectMember(testRoomCode, firstJoin.body.sessionToken);
  const afterReconnect = await request(`/api/rooms/${testRoomCode}`, undefined, created.body.sessionToken);
  assert.ok(afterReconnect.body.room.participants.some((person) => person.userId === guestUserId),
    "A reconnect during disconnect processing must leave the participant online.");

  for (const [event, payload] of [
    ["play", { currentTime: 3 }], ["pause", { currentTime: 4 }], ["seek", { time: 17 }],
    ["change_video", { videoId: "dQw4w9WgXcQ" }],
  ]) {
    const guestSync = nextEvent(guest.socket, "sync_state");
    const hostSync = nextEvent(host.socket, "sync_state");
    const action = await emitAck(host.socket, event, payload);
    assert.equal(action.ok, true, `Host ${event} must be allowed.`);
    await Promise.all([guestSync, hostSync]);
  }

  for (const [event, payload, expected] of [
    ["play", { currentTime: 0 }, { playbackState: "playing" }],
    ["pause", { currentTime: 2 }, { playbackState: "paused" }],
    ["seek", { time: 37 }, { currentTime: 37 }],
    ["change_video", { videoId: "M7lc1UVf-VE" }, { currentVideo: "M7lc1UVf-VE", playbackState: "paused", currentTime: 0 }],
  ]) {
    const hostSync = nextEvent(host.socket, "sync_state");
    const guestSync = nextEvent(guest.socket, "sync_state");
    const action = await emitAck(guest.socket, event, payload);
    assert.equal(action.ok, true, `${event}: ${action.error?.message || "failed"}`);
    const states = await Promise.all([hostSync, guestSync]);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(action.room[key], value, `${event} acknowledgement must contain authoritative ${key}.`);
      for (const state of states) assert.equal(state[key], value, `${event} broadcast must synchronize ${key}.`);
    }
  }
  const negativeSeek = await emitAck(guest.socket, "seek", { time: -1 });
  assert.equal(negativeSeek.ok, false); assert.equal(negativeSeek.error.code, "INVALID_SEEK");
  const nonFiniteSeek = await emitAck(host.socket, "seek", { time: Number.NaN });
  assert.equal(nonFiniteSeek.ok, false); assert.equal(nonFiniteSeek.error.code, "INVALID_SEEK");
  const badVideo = await emitAck(host.socket, "change_video", { videoId: "bad" });
  assert.equal(badVideo.ok, false); assert.equal(badVideo.error.code, "INVALID_VIDEO_ID");

  // Emit bursts without waiting for each acknowledgement. The final persisted state
  // must follow packet arrival order for both debounced seeks and immediate actions.
  const rapidSeekResults = await Promise.all([10, 20, 30].map((time) => emitAck(host.socket, "seek", { time })));
  assert.ok(rapidSeekResults.every((result) => result.ok));
  await delay(1450);
  let persisted = await request(`/api/rooms/${testRoomCode}`);
  assert.equal(persisted.body.room.currentTime, 30, "Rapid seeks must persist the last arrived seek.");

  const playPausePlay = await Promise.all([
    emitAck(host.socket, "play", { currentTime: 40 }),
    emitAck(host.socket, "pause", { currentTime: 41 }),
    emitAck(host.socket, "play", { currentTime: 42 }),
  ]);
  assert.ok(playPausePlay.every((result) => result.ok));
  await delay(150);
  persisted = await request(`/api/rooms/${testRoomCode}`);
  assert.equal(persisted.body.room.playbackState, "playing", "Play-pause-play must end in playing state.");
  assert.ok(persisted.body.room.currentTime >= 42, "Play-pause-play must retain the final event time.");

  const videoA = "M7lc1UVf-VE";
  const videoB = "dQw4w9WgXcQ";
  const rapidVideos = await Promise.all([
    emitAck(host.socket, "change_video", { videoId: videoA }),
    emitAck(host.socket, "change_video", { videoId: videoB }),
    emitAck(host.socket, "change_video", { videoId: videoA }),
  ]);
  assert.ok(rapidVideos.every((result) => result.ok));
  await delay(150);
  persisted = await request(`/api/rooms/${testRoomCode}`);
  assert.equal(persisted.body.room.currentVideo, videoA, "Rapid video changes must persist the last arrived video.");
  assert.equal(persisted.body.room.playbackState, "paused");
  assert.equal(persisted.body.room.currentTime, 0);

  await emitAck(guest.socket, "play", { currentTime: 25 });
  const secondJoin = await request(`/api/rooms/${testRoomCode}/join`, { username: "Second Guest" });
  assert.equal(secondJoin.status, 201);
  const secondJoinedNotice = nextEvent(host.socket, "user_joined");
  const secondGuest = await connectMember(testRoomCode, secondJoin.body.sessionToken);
  assert.equal(secondGuest.initialSync.currentUser.role, "participant");
  assert.equal(secondGuest.initialSync.playbackState, "playing", "New users must receive current play state.");
  assert.ok(secondGuest.initialSync.currentTime >= 25, "New users must receive current playback time.");
  assert.equal((await secondJoinedNotice).participants.length, 3);

  const guestRemoved = nextEvent(guest.socket, "participant_removed");
  const hostRemoved = nextEvent(host.socket, "participant_removed");
  const removal = await emitAck(host.socket, "remove_participant", { userId: guest.initialSync.currentUser.userId });
  assert.equal(removal.ok, true);
  assert.equal((await guestRemoved).userId, guest.initialSync.currentUser.userId);
  assert.equal((await hostRemoved).participants.length, 2, "Removed participant must be deleted from the room list.");
  const removeHost = await emitAck(host.socket, "remove_participant", { userId: host.initialSync.currentUser.userId });
  assert.equal(removeHost.ok, false, "Host cannot remove themself.");

  const leftNotice = nextEvent(host.socket, "user_left");
  assert.equal((await emitAck(secondGuest.socket, "leave_room", {})).ok, true);
  assert.equal((await leftNotice).userId, secondGuest.initialSync.currentUser.userId);
  const leftThenRejoined = await connectMember(testRoomCode, secondJoin.body.sessionToken);
  const afterLeaveReconnect = await request(`/api/rooms/${testRoomCode}`);
  assert.ok(afterLeaveReconnect.body.room.participants.some((person) => person.userId === leftThenRejoined.initialSync.currentUser.userId),
    "A participant must return online when reconnecting after an explicit leave.");
  leftThenRejoined.socket.disconnect();
  await delay(100);
  const thirdJoin = await request(`/api/rooms/${testRoomCode}/join`, { username: "Disconnect Guest" });
  const disconnectNotice = nextEvent(host.socket, "user_left");
  const thirdGuest = await connectMember(testRoomCode, thirdJoin.body.sessionToken);
  thirdGuest.socket.disconnect();
  assert.equal((await disconnectNotice).userId, thirdGuest.initialSync.currentUser.userId);
  await delay(100);
  const afterDisconnect = await request(`/api/rooms/${testRoomCode}`, undefined, created.body.sessionToken);
  assert.ok(!afterDisconnect.body.room.participants.some((person) => person.userId === thirdGuest.initialSync.currentUser.userId));
  assert.equal(afterDisconnect.body.room.currentVideo, videoA, "Room playback state must persist in MongoDB.");

  const reusedOfflineName = await request(`/api/rooms/${testRoomCode}/join`, { username: "Disconnect Guest" });
  assert.equal(reusedOfflineName.status, 201, "Offline participant names must be reusable.");
  const reusedGuest = await connectMember(testRoomCode, reusedOfflineName.body.sessionToken);
  const afterNameReuse = await request(`/api/rooms/${testRoomCode}`);
  assert.ok(afterNameReuse.body.room.participants.some((person) => person.userId === reusedGuest.initialSync.currentUser.userId),
    "A participant reusing an offline name must become an active room member.");
  assert.equal(afterNameReuse.body.room.participants.filter((person) => person.username === "Disconnect Guest").length, 1,
    "Only the online session should appear for a reused offline username.");
  console.log("Realtime integration passed: authorization, role changes, late join, reconnect membership, ordered rapid playback and seek persistence, offline username reuse, removal, leave, disconnect, and MongoDB persistence.");
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  for (const socket of sockets) socket.disconnect();
  if (testRoomCode) await Room.deleteOne({ roomCode: testRoomCode }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
});
