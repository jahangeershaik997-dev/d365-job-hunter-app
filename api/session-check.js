const { resolveUser } = require("../middleware/auth");

// Vercel routes /api/* to a matching file BEFORE it ever reaches server.js's
// Express app - a route defined only inside server.js under an /api/ path
// is unreachable in production. This file (not server.js) is what actually
// serves GET /api/session-check.
module.exports = async (req, res) => {
  const { user, sessionId } = await resolveUser(req);
  res.json({
    loggedIn: !!user,
    user: user ? {
      name: user.displayName,
      email: user.email
    } : null,
    sessionId: sessionId ? sessionId.substring(0, 10) + "..." : null,
    upstashConfigured: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  });
};
