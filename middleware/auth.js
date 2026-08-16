const { getSession, COOKIE_NAME } = require("../lib/session");

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach(part => {
    const index = part.indexOf("=");
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

async function loadSession(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) { req.user = null; return next(); }
    const session = await getSession(sessionId);
    if (!session) { req.user = null; return next(); }
    req.sessionId = sessionId;
    req.user = session;
    next();
  } catch(e) {
    console.log("Session error:", e.message);
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/auth/google");
  next();
}

module.exports = { loadSession, requireAuth };
