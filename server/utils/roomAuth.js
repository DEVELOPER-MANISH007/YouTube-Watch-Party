const ROLES = Object.freeze({ HOST: "host", MODERATOR: "moderator", PARTICIPANT: "participant" });
const ACTIONS = Object.freeze({
  PLAY: "play", PAUSE: "pause", SEEK: "seek", CHANGE_VIDEO: "change_video",
  ASSIGN_ROLE: "assign_role", REMOVE_PARTICIPANT: "remove_participant",
});

function canPerform(role, action) {
  if ([ACTIONS.PLAY, ACTIONS.PAUSE, ACTIONS.SEEK, ACTIONS.CHANGE_VIDEO].includes(action)) {
    return role === ROLES.HOST || role === ROLES.MODERATOR;
  }
  if ([ACTIONS.ASSIGN_ROLE, ACTIONS.REMOVE_PARTICIPANT].includes(action)) return role === ROLES.HOST;
  return false;
}

function findParticipant(room, userId) {
  return room?.participants?.find((participant) => participant.userId === userId) || null;
}

module.exports = { ROLES, ACTIONS, canPerform, findParticipant };
