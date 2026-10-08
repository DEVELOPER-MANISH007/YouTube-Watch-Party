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
const testRoomCodes = [];
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

async function connectBareSocket() {
  const socket = io(API, { autoConnect: false, transports: ["websocket"] });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Socket.IO server.")), 6000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });
  return socket;
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required in server/.env for the realtime verification.");
  await mongoose.connect(process.env.MONGODB_URI);
  const makeRoom = async (hostName) => {
    const result = await request("/api/rooms", { username: hostName });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    testRoomCodes.push(result.body.room.roomCode);
    const hostMember = await connectMember(result.body.room.roomCode, result.body.sessionToken);
    return { code: result.body.room.roomCode, token: result.body.sessionToken, host: hostMember };
  };
  const makeGuest = async (code, username) => {
    const joined = await request(`/api/rooms/${code}/join`, { username });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    return { token: joined.body.sessionToken, ...(await connectMember(code, joined.body.sessionToken)) };
  };

  const invalidCreate = await request("/api/rooms", { username: "  ", videoId: null });
  assert.equal(invalidCreate.status, 400, "Server must reject a missing username.");
  const missingRoom = await request("/api/rooms/NOPE-1234");
  assert.equal(missingRoom.status, 404, "Room lookup must reject an unknown room code.");
  const created = await request("/api/rooms", { username: "Realtime Host", videoId: "dQw4w9WgXcQ" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  testRoomCode = created.body.room.roomCode;
  testRoomCodes.push(testRoomCode);
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

  const approvalPeer = await makeGuest(testRoomCode, "Approval Peer");
  const stateBeforeApproval = (await request(`/api/rooms/${testRoomCode}`)).body.room;
  let hostRequestList = nextEvent(host.socket, "pending_action_requests");
  let guestRequestStatus = nextEvent(guest.socket, "action_request_status");
  const requestToReject = await emitAck(guest.socket, "request_action", { action: "play", payload: { currentTime: 18 } });
  assert.equal(requestToReject.ok, true, "Participant playback request should be accepted for review.");
  const hostPending = await hostRequestList;
  assert.equal(hostPending.length, 1, "Host must receive pending participant requests.");
  assert.equal(hostPending[0].username, "Realtime Guest");
  assert.equal((await guestRequestStatus).status, "pending", "Requester must see pending status.");
  const unauthorizedApproval = await emitAck(approvalPeer.socket, "resolve_action_request", {
    requestId: requestToReject.requestId, decision: "approve",
  });
  assert.equal(unauthorizedApproval.ok, false, "A Participant cannot approve another user's request.");
  assert.equal(unauthorizedApproval.error.code, "FORBIDDEN");
  const guestSelfApproval = await emitAck(guest.socket, "resolve_action_request", {
    requestId: requestToReject.requestId, decision: "approve",
  });
  assert.equal(guestSelfApproval.ok, false, "A Participant cannot approve their own request.");
  const rejectedStatus = nextEvent(guest.socket, "action_request_status");
  assert.equal((await emitAck(host.socket, "resolve_action_request", {
    requestId: requestToReject.requestId, decision: "reject",
  })).ok, true, "Host must be able to reject a request.");
  assert.equal((await rejectedStatus).status, "rejected", "Requester must receive rejection status.");
  const afterReject = (await request(`/api/rooms/${testRoomCode}`)).body.room;
  assert.equal(afterReject.currentVideo, stateBeforeApproval.currentVideo);
  assert.equal(afterReject.playbackState, stateBeforeApproval.playbackState, "Rejection must not change playback.");
  assert.equal(afterReject.currentTime, stateBeforeApproval.currentTime, "Rejection must not change playback position.");
  assert.equal((await emitAck(host.socket, "resolve_action_request", {
    requestId: requestToReject.requestId, decision: "approve",
  })).error.code, "STALE_REQUEST", "A resolved request cannot be approved twice.");

  for (const invalidRequest of [
    { action: "remove_participant", payload: {} },
    { action: "seek", payload: { time: -1 } },
    { action: "change_video", payload: { videoId: "bad-id" } },
  ]) {
    const invalid = await emitAck(guest.socket, "request_action", invalidRequest);
    assert.equal(invalid.ok, false, "Invalid playback requests must be rejected.");
  }
  const pendingForSelf = await emitAck(guest.socket, "request_action", { action: "seek", payload: { time: 22 } });
  assert.equal(pendingForSelf.ok, true);
  const approvedStatus = nextEvent(guest.socket, "action_request_status");
  const syncFromApproval = nextEvent(guest.socket, "sync_state");
  const hostApproval = await emitAck(host.socket, "resolve_action_request", {
    requestId: pendingForSelf.requestId, decision: "approve",
  });
  assert.equal(hostApproval.ok, true, "Host approval should apply the requested playback action.");
  assert.equal((await syncFromApproval).currentTime, 22, "Approved action must broadcast authoritative playback state.");
  assert.equal((await approvedStatus).status, "approved");

  const participantDeniedAfterRequest = await emitAck(guest.socket, "play", { currentTime: 19 });
  assert.equal(participantDeniedAfterRequest.ok, false, "Creating a request must not grant direct playback permission.");
  assert.equal(participantDeniedAfterRequest.error.code, "FORBIDDEN");

  const cancelledRequest = await emitAck(approvalPeer.socket, "request_action", { action: "seek", payload: { time: 77 } });
  assert.equal(cancelledRequest.ok, true);
  const peerDisconnected = nextEvent(host.socket, "pending_action_requests");
  approvalPeer.socket.disconnect();
  const remainingRequests = await peerDisconnected;
  assert.equal(remainingRequests.some((item) => item.requestId === cancelledRequest.requestId), false,
    "Disconnecting requester must be removed from the pending list.");
  const staleDisconnected = await emitAck(host.socket, "resolve_action_request", {
    requestId: cancelledRequest.requestId, decision: "approve",
  });
  assert.equal(staleDisconnected.ok, false, "A disconnected participant request cannot later mutate playback.");
  assert.equal(staleDisconnected.error.code, "STALE_REQUEST");

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

  const roleChangeRequest = await emitAck(guest.socket, "request_action", { action: "pause", payload: {} });
  assert.equal(roleChangeRequest.ok, true);
  const roleChangeRequestStatus = nextEvent(guest.socket, "action_request_status");
  const hostRoleUpdate = nextEvent(host.socket, "role_assigned");
  const guestRoleUpdate = nextEvent(guest.socket, "role_assigned");
  const promotion = await emitAck(host.socket, "assign_role", { userId: guest.initialSync.currentUser.userId, role: "moderator" });
  assert.equal(promotion.ok, true);
  assert.equal((await hostRoleUpdate).participant.role, "moderator");
  await guestRoleUpdate;
  assert.equal((await roleChangeRequestStatus).status, "cancelled", "Promotion out of Participant role cancels pending requests.");
  const roleChangedStale = await emitAck(host.socket, "resolve_action_request", {
    requestId: roleChangeRequest.requestId, decision: "approve",
  });
  assert.equal(roleChangedStale.ok, false, "A request made as a Participant cannot be approved after promotion.");
  assert.equal(roleChangedStale.error.code, "STALE_REQUEST");
  const moderatorRequester = await makeGuest(testRoomCode, "Moderator Requester");
  const moderatorPending = nextEvent(guest.socket, "pending_action_requests");
  const moderatorRequesterStatus = nextEvent(moderatorRequester.socket, "action_request_status");
  const moderatorRequest = await emitAck(moderatorRequester.socket, "request_action", {
    action: "change_video", payload: { videoId: "M7lc1UVf-VE" },
  });
  assert.equal(moderatorRequest.ok, true);
  assert.equal((await moderatorPending)[0].requestId, moderatorRequest.requestId,
    "Moderator must receive pending Participant requests.");
  assert.equal((await moderatorRequesterStatus).status, "pending");
  const moderatorSync = nextEvent(host.socket, "sync_state");
  const requesterSync = nextEvent(moderatorRequester.socket, "sync_state");
  const moderatorApprovedStatus = nextEvent(moderatorRequester.socket, "action_request_status");
  const moderatorApproval = await emitAck(guest.socket, "resolve_action_request", {
    requestId: moderatorRequest.requestId, decision: "approve",
  });
  assert.equal(moderatorApproval.ok, true, "Moderator with playback permission may approve a request.");
  assert.equal((await moderatorSync).currentVideo, "M7lc1UVf-VE");
  assert.equal((await requesterSync).currentVideo, "M7lc1UVf-VE");
  assert.equal((await moderatorApprovedStatus).status, "approved");
  const removedRequesterRequest = await emitAck(moderatorRequester.socket, "request_action", { action: "seek", payload: { time: 88 } });
  assert.equal(removedRequesterRequest.ok, true);
  const removedRequestStatus = nextEvent(moderatorRequester.socket, "action_request_status");
  const removedNotice = nextEvent(moderatorRequester.socket, "participant_removed");
  assert.equal((await emitAck(host.socket, "remove_participant", { userId: moderatorRequester.initialSync.currentUser.userId })).ok, true);
  await removedNotice;
  assert.equal((await removedRequestStatus).status, "cancelled", "Removing a requester must cancel its pending request.");
  const removedRequestApproval = await emitAck(host.socket, "resolve_action_request", {
    requestId: removedRequesterRequest.requestId, decision: "approve",
  });
  assert.equal(removedRequestApproval.ok, false, "A removed participant request cannot later mutate playback.");
  assert.equal(removedRequestApproval.error.code, "STALE_REQUEST");
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
  const removedSocket = await connectBareSocket();
  const removedReconnect = await emitAck(removedSocket, "join_room", { roomCode: testRoomCode, sessionToken: firstJoin.body.sessionToken });
  assert.equal(removedReconnect.ok, false, "A removed session must not reconnect to the room.");
  assert.equal(removedReconnect.error.code, "ROOM_NOT_FOUND");
  removedSocket.disconnect();
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

  // A transferred Host is selected explicitly and can exercise Host-only actions;
  // the old Host loses membership and cannot keep controlling the room.
  for (const [newRole, suffix] of [["participant", "Participant"], ["moderator", "Moderator"]]) {
    const transferRoom = await makeRoom(`Transfer Host ${suffix}`);
    const candidate = await makeGuest(transferRoom.code, `Candidate ${suffix}`);
    const other = await makeGuest(transferRoom.code, `Other ${suffix}`);
    if (newRole === "moderator") {
      assert.equal((await emitAck(transferRoom.host.socket, "assign_role", {
        userId: candidate.initialSync.currentUser.userId, role: "moderator",
      })).ok, true);
    }
    const beforePromotion = await emitAck(candidate.socket, "assign_role", {
      userId: other.initialSync.currentUser.userId, role: "participant",
    });
    assert.equal(beforePromotion.ok, false, "Candidate must not have Host permissions before promotion.");
    assert.equal(beforePromotion.error.code, "FORBIDDEN");
    const playbackBefore = (await request(`/api/rooms/${transferRoom.code}`)).body.room;
    const roleUpdate = nextEvent(candidate.socket, "role_assigned");
    const transferred = await emitAck(transferRoom.host.socket, "transfer_host", { userId: candidate.initialSync.currentUser.userId });
    assert.equal(transferred.ok, true, transferred.error?.message);
    const receivedRoleUpdate = await roleUpdate;
    assert.equal(receivedRoleUpdate.participant.userId, candidate.initialSync.currentUser.userId);
    assert.equal(receivedRoleUpdate.participant.role, "host");
    assert.ok(!receivedRoleUpdate.participants.some((person) => person.userId === transferRoom.host.initialSync.currentUser.userId),
      "Old Host must leave the online room membership list after transfer.");
    const oldHostControl = await emitAck(transferRoom.host.socket, "play", { currentTime: 99 });
    assert.equal(oldHostControl.ok, false, "Old Host must lose control after explicitly leaving.");
    assert.equal(oldHostControl.error.code, "NOT_IN_ROOM");
    assert.equal((await emitAck(candidate.socket, "assign_role", {
      userId: other.initialSync.currentUser.userId, role: "moderator",
    })).ok, true, "Promoted participant must receive Host permissions.");
    const playbackAfter = (await request(`/api/rooms/${transferRoom.code}`)).body.room;
    assert.equal(playbackAfter.currentVideo, playbackBefore.currentVideo, "Host transfer must preserve video.");
    assert.equal(playbackAfter.currentTime, playbackBefore.currentTime, "Host transfer must preserve playback position.");
    assert.equal(playbackAfter.sessionEnded, false, "Host transfer must keep the session active.");
    const transferRequester = await makeGuest(transferRoom.code, `Transfer Requester ${suffix}`);
    const transferRequestStatus = nextEvent(transferRequester.socket, "action_request_status");
    const transferredHostRequests = nextEvent(candidate.socket, "pending_action_requests");
    const transferRequest = await emitAck(transferRequester.socket, "request_action", { action: "seek", payload: { time: 31 } });
    assert.equal(transferRequest.ok, true);
    assert.ok((await transferredHostRequests).some((item) => item.requestId === transferRequest.requestId),
      "The current Host must receive pending requests after Host transfer.");
    assert.equal((await transferRequestStatus).status, "pending");
    const transferApprovedStatus = nextEvent(transferRequester.socket, "action_request_status");
    const oldHostRequestAction = await emitAck(transferRoom.host.socket, "resolve_action_request", {
      requestId: transferRequest.requestId, decision: "approve",
    });
    assert.equal(oldHostRequestAction.ok, false, "The former Host cannot approve after transferring Host.");
    const transferredSync = nextEvent(transferRequester.socket, "sync_state");
    assert.equal((await emitAck(candidate.socket, "resolve_action_request", {
      requestId: transferRequest.requestId, decision: "approve",
    })).ok, true, "The new Host can approve pending requests.");
    assert.equal((await transferredSync).currentTime, 31);
    assert.equal((await transferApprovedStatus).status, "approved");
    assert.equal((await emitAck(transferRequester.socket, "leave_room", {})).ok, true);
    assert.equal((await emitAck(other.socket, "leave_room", {})).ok, true, "Participant leave should succeed.");
    assert.ok((await request(`/api/rooms/${transferRoom.code}`)).body.room, "Participant leave must keep the room active.");
    const moderatorJoin = await request(`/api/rooms/${transferRoom.code}/join`, { username: `Moderator Leave ${suffix}` });
    assert.equal(moderatorJoin.status, 201);
    const moderator = await connectMember(transferRoom.code, moderatorJoin.body.sessionToken);
    assert.equal((await emitAck(candidate.socket, "assign_role", {
      userId: moderator.initialSync.currentUser.userId, role: "moderator",
    })).ok, true);
    assert.equal((await emitAck(moderator.socket, "leave_room", {})).ok, true, "Moderator leave should succeed.");
    assert.equal((await request(`/api/rooms/${transferRoom.code}`)).body.room.sessionEnded, false,
      "Moderator leave must not end the room.");
  }

  // Empty rooms cannot transfer to a nonexistent participant.
  const emptyRoom = await makeRoom("Empty Transfer Host");
  const noCandidate = await emitAck(emptyRoom.host.socket, "transfer_host", { userId: "missing-user" });
  assert.equal(noCandidate.ok, false, "Host cannot leave an ownerless active room.");
  assert.equal(noCandidate.error.code, "HOST_NOT_ELIGIBLE");
  assert.equal((await emitAck(emptyRoom.host.socket, "play", { currentTime: 1 })).ok, true,
    "Host must remain in control when no transfer candidate exists.");

  const unavailableRoom = await makeRoom("Available Host");
  const unavailableCandidate = await makeGuest(unavailableRoom.code, "Departing Candidate");
  unavailableCandidate.socket.disconnect();
  await delay(100);
  const staleTransfer = await emitAck(unavailableRoom.host.socket, "transfer_host", {
    userId: unavailableCandidate.initialSync.currentUser.userId,
  });
  assert.equal(staleTransfer.ok, false, "A participant who left before confirmation cannot become Host.");
  assert.equal(staleTransfer.error.code, "HOST_NOT_ELIGIBLE");
  assert.equal((await emitAck(unavailableRoom.host.socket, "play", { currentTime: 2 })).ok, true,
    "Host must retain control when a proposed transfer candidate becomes unavailable.");

  // Explicit End Session notifies connected members, rejects reconnects and blocks
  // further control from the ended room's former Host.
  const endedRoom = await makeRoom("Ending Host");
  const endedGuest = await makeGuest(endedRoom.code, "Ending Guest");
  const endedNotice = nextEvent(endedGuest.socket, "session_ended");
  const endedRequest = await emitAck(endedGuest.socket, "request_action", { action: "pause", payload: {} });
  assert.equal(endedRequest.ok, true);
  const endedRequestStatus = nextEvent(endedGuest.socket, "action_request_status");
  assert.equal((await emitAck(endedRoom.host.socket, "end_session", {})).ok, true);
  assert.equal((await endedNotice).reason, "host_ended");
  assert.equal((await endedRequestStatus).status, "session_ended", "Ending the room must cancel pending requests.");
  const endedControl = await emitAck(endedRoom.host.socket, "play", { currentTime: 12 });
  assert.equal(endedControl.ok, false, "Ended session must reject the former Host's control.");
  const endedJoin = await request(`/api/rooms/${endedRoom.code}/join`, { username: "Late Joiner" });
  assert.equal(endedJoin.status, 410, "Ended session must reject new room sessions.");
  const oldGuestSocket = await connectBareSocket();
  const endedReconnect = await emitAck(oldGuestSocket, "join_room", { roomCode: endedRoom.code, sessionToken: endedGuest.token });
  assert.equal(endedReconnect.ok, false, "Participants cannot reconnect into an ended session.");
  assert.equal(endedReconnect.error.code, "SESSION_ENDED");

  // A host disconnect ends the session only after the existing reconnect check;
  // ordinary non-host leave/disconnect above leaves the room active.
  const disconnectedHostRoom = await makeRoom("Disconnecting Host");
  const disconnectGuest = await makeGuest(disconnectedHostRoom.code, "Disconnect Host Guest");
  const disconnectEndedNotice = nextEvent(disconnectGuest.socket, "session_ended");
  disconnectedHostRoom.host.socket.disconnect();
  assert.equal((await disconnectEndedNotice).reason, "host_disconnected");
  const disconnectedHostJoin = await connectBareSocket();
  const rejectedOldHost = await emitAck(disconnectedHostJoin, "join_room", {
    roomCode: disconnectedHostRoom.code, sessionToken: disconnectedHostRoom.token,
  });
  assert.equal(rejectedOldHost.ok, false, "Old Host cannot revive a disconnected ended session.");
  assert.equal(rejectedOldHost.error.code, "SESSION_ENDED");

  console.log("Realtime integration passed: RBAC, Participant action requests and Host/Moderator approval, rejection and stale-request handling, manual Host transfer, explicit/disconnected Host session end, reconnect rejection, normal participant/moderator leave, playback ordering/persistence, removal, and reconnect race protection.");
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  for (const socket of sockets) socket.disconnect();
  if (testRoomCodes.length) await Room.deleteMany({ roomCode: { $in: testRoomCodes } }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
});
