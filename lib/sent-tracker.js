const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

function normalizeString(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 50);
}

// Check duplicate by candidate + HR email + job title.
// Same candidate + same HR + same job = duplicate (skip).
// Same candidate + same HR + different job = not a duplicate (different pitch).
// Same candidate + different HR at the same company = not a duplicate either.
async function alreadySent(candidateEmail, hrEmail, jobTitle) {
  try {
    const key = `sent:${candidateEmail}:${normalizeString(hrEmail)}:${normalizeString(jobTitle)}`;
    const exists = await redis.exists(key);
    return exists === 1;
  } catch(e) {
    console.log("Tracker check error:", e.message);
    return false;
  }
}

// Mark as sent - expires after 30 days
async function markAsSent(candidateEmail, hrEmail, jobTitle) {
  try {
    const key = `sent:${candidateEmail}:${normalizeString(hrEmail)}:${normalizeString(jobTitle)}`;
    await redis.set(key, "1", { ex: 60 * 60 * 24 * 30 });
    console.log(`📝 Marked sent: ${candidateEmail} → ${hrEmail} (${jobTitle})`);
    return true;
  } catch(e) {
    console.log("Tracker mark error:", e.message);
    return false;
  }
}

async function clearSent(candidateEmail, hrEmail, jobTitle) {
  try {
    const key = `sent:${candidateEmail}:${normalizeString(hrEmail)}:${normalizeString(jobTitle)}`;
    await redis.del(key);
    return true;
  } catch(e) {
    return false;
  }
}

module.exports = { alreadySent, markAsSent, clearSent };
