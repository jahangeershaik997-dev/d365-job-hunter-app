const { resolveUser } = require("../middleware/auth");
const { getApplicationHistory } = require("../lib/history");

// Allow if logged in OR if called from same origin (the dashboard's own fetch)
function isSameOriginRequest(req) {
  const host = req.headers.host;
  const from = req.headers.origin || req.headers.referer || "";
  return !!(host && from && from.includes(host));
}

// Vercel routes /api/* to a matching file BEFORE it ever reaches server.js's
// Express app - a route defined only inside server.js under an /api/ path
// is unreachable in production. This file (not server.js) is what actually
// serves GET /api/history.
module.exports = async (req, res) => {
  const { user } = await resolveUser(req);
  if (!user && !isSameOriginRequest(req)) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }
  try {
    const history = await getApplicationHistory();
    res.json({ success: true, history: history || [] });
  } catch(e) {
    console.log("History error:", e.message);
    res.json({ success: true, history: [] });
  }
};
