const { resolveUser } = require("../middleware/auth");

const JSONBIN_BIN_ID = "6a7fe014f5f4af5e29189def";
const JSONBIN_MASTER_KEY = "$2a$10$mOTOfSBdMCPsMoeb7FIaVubVgsRJqsgyheEbJc2nZ6aZ5p3cKzVJa";

// Allow if logged in OR if called from same origin (the dashboard's own fetch)
function isSameOriginRequest(req) {
  const host = req.headers.host;
  const from = req.headers.origin || req.headers.referer || "";
  return !!(host && from && from.includes(host));
}

// Vercel routes /api/* to a matching file BEFORE it ever reaches server.js's
// Express app - a route defined only inside server.js under an /api/ path
// is unreachable in production. This file (not server.js) is what actually
// serves GET /api/candidates.
module.exports = async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user && !isSameOriginRequest(req)) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }
  try {
    const resBin = await fetch(
      `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID || JSONBIN_BIN_ID}/latest`,
      { headers: { "X-Master-Key": process.env.JSONBIN_MASTER_KEY || JSONBIN_MASTER_KEY } }
    );
    const data = await resBin.json();
    const candidates = Array.isArray(data.record)
      ? data.record.filter(c => !c.init && c.email && c.name)
      : [];
    res.json({
      success: true,
      candidates: candidates.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        experience: c.experience,
        role: c.role,
        registeredAt: c.registeredAt
      }))
    });
  } catch(e) {
    console.log("Candidates error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
};
