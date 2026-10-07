const { createHash, randomBytes, randomUUID } = require("node:crypto");

function createSession() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token), userId: randomUUID() };
}

function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

module.exports = { createSession, hashSessionToken };
