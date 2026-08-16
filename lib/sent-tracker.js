const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// Check if candidate already emailed this company
async function alreadySent(candidateEmail, hrEmail) {
  try {
    const key = `sent:${candidateEmail}:${hrEmail}`;
    const exists = await redis.exists(key);
    return exists === 1;
  } catch(e) {
    console.log("Tracker check error:", e.message);
    return false;
  }
}

// Mark as sent - expires after 30 days
async function markAsSent(candidateEmail, hrEmail) {
  try {
    const key = `sent:${candidateEmail}:${hrEmail}`;
    await redis.set(key, "1", { ex: 60 * 60 * 24 * 30 });
    return true;
  } catch(e) {
    console.log("Tracker mark error:", e.message);
    return false;
  }
}

module.exports = { alreadySent, markAsSent };
