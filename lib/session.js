const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const SESSION_TTL = 60 * 60 * 24 * 30;
const COOKIE_NAME = "d365_sid";

function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

async function createSession(data) {
  const sessionId = generateSessionId();
  await redis.set(
    `session:${sessionId}`,
    JSON.stringify({ ...data, createdAt: Date.now() }),
    { ex: SESSION_TTL }
  );
  return sessionId;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  const data = await redis.get(`session:${sessionId}`);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function destroySession(sessionId) {
  if (!sessionId) return;
  await redis.del(`session:${sessionId}`);
}

module.exports = { createSession, getSession, destroySession, COOKIE_NAME };
