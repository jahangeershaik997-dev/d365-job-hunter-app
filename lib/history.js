const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

async function saveApplication(data) {
  try {
    const key = `app:${Date.now()}:${Math.random().toString(36).substr(2,9)}`;
    await redis.set(key, JSON.stringify({
      candidateName: data.candidateName,
      candidateEmail: data.candidateEmail,
      company: data.company,
      hrEmail: data.hrEmail,
      subject: data.subject,
      sent: data.sent,
      timestamp: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    }), { ex: 60 * 60 * 24 * 90 });
    return true;
  } catch(e) {
    console.log("History save error:", e.message);
    return false;
  }
}

async function getApplicationHistory() {
  try {
    const keys = await redis.keys("app:*");
    if (!keys || keys.length === 0) return [];
    const values = await Promise.all(keys.map(k => redis.get(k)));
    return values
      .filter(Boolean)
      .map(v => typeof v === "string" ? JSON.parse(v) : v)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch(e) {
    console.log("History fetch error:", e.message);
    return [];
  }
}

module.exports = { saveApplication, getApplicationHistory };
