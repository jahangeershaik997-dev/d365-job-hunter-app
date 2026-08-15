const express = require("express");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");

const app = express();

const JSONBIN_BIN_ID = "6a7fe014f5f4af5e29189def";
const JSONBIN_MASTER_KEY = "$2a$10$mOTOfSBdMCPsMoeb7FIaVubVgsRJqsgyheEbJc2nZ6aZ5p3cKzVJa";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "d365secret",
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://d365-job-hunter-app.vercel.app/auth/callback"
}, (accessToken, refreshToken, profile, done) => {
  // Save BOTH tokens to profile
  profile.accessToken = accessToken;
  profile.refreshToken = refreshToken;
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const upload = multer({ storage: multer.memoryStorage() });

async function getCandidates() {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    const records = data.record;
    return Array.isArray(records) ? records.filter(c => !c.init) : [];
  } catch(e) {
    return [];
  }
}

async function saveCandidate(candidate) {
  const candidates = await getCandidates();
  const existing = candidates.findIndex(c => c.email === candidate.email);
  if (existing >= 0) candidates[existing] = { ...candidates[existing], ...candidate };
  else candidates.push(candidate);
  await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": JSONBIN_MASTER_KEY
    },
    body: JSON.stringify(candidates)
  });
}

app.get("/", async (req, res) => {
  const candidates = await getCandidates();
  res.render("index", { user: req.user, candidateCount: candidates.length });
});

app.get("/register", (req, res) => {
  res.render("register", { user: req.user, error: req.query.error || null });
});

app.post("/register", upload.single("resume"), async (req, res) => {
  if (!req.user) return res.redirect("/auth/google");
  if (!req.file) return res.redirect("/register?error=Please upload your resume");

  await saveCandidate({
    id: req.user.id,
    name: req.body.name || req.user.displayName,
    email: req.user.emails[0].value,
    experience: req.body.experience,
    role: req.body.role,
    accessToken: req.user.accessToken,
    refreshToken: req.user.refreshToken,
    registeredAt: new Date().toISOString()
  });

  res.redirect("/dashboard");
});

app.get("/dashboard", async (req, res) => {
  if (!req.user) return res.redirect("/");
  const candidates = await getCandidates();
  const me = candidates.find(c => c.email === req.user.emails[0].value);
  res.render("dashboard", { user: req.user, candidate: me, candidates });
});

app.get("/auth/google", passport.authenticate("google", {
  scope: ["profile", "email", "https://www.googleapis.com/auth/gmail.send"],
  accessType: "offline",
  prompt: "consent"
}));

app.get("/auth/callback", passport.authenticate("google", {
  failureRedirect: "/"
}), (req, res) => {
  res.redirect("/register");
});

app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
  });
}

module.exports = app;
