export const ROLES = Object.freeze({ HOST: "host", MODERATOR: "moderator", PARTICIPANT: "participant" });
export const canControlPlayback = (role) => role === ROLES.HOST || role === ROLES.MODERATOR;
export const canChangeVideo = canControlPlayback;
export const canAssignRole = (role) => role === ROLES.HOST;
export const canRemoveParticipant = canAssignRole;
