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

// Framework-independent: works with Express req AND bare Vercel function
// req objects, since both only need req.headers.cookie. Used by loadSession
// (Express middleware) and by the standalone api/*.js functions that Vercel
// routes directly (those never go through server.js's middleware chain).
async function resolveUser(req) {
  try {
    const cookies = parseCookies(req);
    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) return { user: null, sessionId: null };
    const session = await getSession(sessionId);
    if (!session) return { user: null, sessionId: null };
    return { user: session, sessionId };
  } catch(e) {
    console.log("Session error:", e.message);
    return { user: null, sessionId: null };
  }
}

async function loadSession(req, res, next) {
  const { user, sessionId } = await resolveUser(req);
  req.user = user;
  req.sessionId = sessionId;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/auth/google");
  next();
}

module.exports = { loadSession, requireAuth, resolveUser };
