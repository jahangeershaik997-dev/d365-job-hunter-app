const { resolveUser } = require("../middleware/auth");
const sendDailyApplications = require("./send-daily-applications");

// Lets an external scheduler (e.g. GitHub Actions, since it has no browser
// session cookie) trigger this without making the endpoint fully public.
// Set RUN_NOW_SECRET in Vercel env vars and pass the same value as the
// x-run-now-secret header from the caller.
const RUN_NOW_SECRET = process.env.RUN_NOW_SECRET;

// Vercel routes /api/* to a matching file BEFORE it ever reaches server.js's
// Express app - a route defined only inside server.js under an /api/ path
// is unreachable in production. This file (not server.js) is what actually
// serves POST /api/run-now.
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const { user } = await resolveUser(req);
  const providedSecret = req.headers["x-run-now-secret"];
  const hasValidSecret = !!RUN_NOW_SECRET && providedSecret === RUN_NOW_SECRET;

  if (!user && !hasValidSecret) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }

  try {
    console.log("🚀 Manual run triggered by:", user ? user.email : "automation (shared secret)");
    await sendDailyApplications(req, res);
  } catch(e) {
    console.log("Run now error:", e.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
};
