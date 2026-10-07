function effectiveTime(room, now = Date.now()) {
  if (!room.isPlaying) return Math.max(0, room.currentTime || 0);
  const updatedAt = new Date(room.playbackUpdatedAt || room.updatedAt || now).getTime();
  return Math.max(0, (room.currentTime || 0) + Math.max(0, now - updatedAt) / 1000);
}

function serializeRoom(room, currentUserId = null, now = Date.now()) {
  const participants = room.participants || [];
  const currentUser = participants.find((person) => person.userId === currentUserId);
  return {
    roomId: String(room._id),
    roomCode: room.roomCode,
    currentVideo: room.currentVideoId || null,
    playbackState: room.isPlaying ? "playing" : "paused",
    currentTime: effectiveTime(room, now),
    updatedAt: now,
    participants: participants.filter((person) => person.isOnline).map(({ userId, username, role }) => ({ userId, username, role })),
    currentUser: currentUser ? { userId: currentUser.userId, username: currentUser.username, role: currentUser.role } : null,
  };
}

module.exports = { effectiveTime, serializeRoom };
