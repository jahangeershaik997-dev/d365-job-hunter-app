const express = require("express");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");
const Groq = require("groq-sdk");
const { createSession, destroySession, COOKIE_NAME } = require("./lib/session");
const { loadSession } = require("./middleware/auth");

const app = express();

const JSONBIN_BIN_ID = "6a7fe014f5f4af5e29189def";
const JSONBIN_MASTER_KEY = "$2a$10$mOTOfSBdMCPsMoeb7FIaVubVgsRJqsgyheEbJc2nZ6aZ5p3cKzVJa";
const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(loadSession);
app.use(passport.initialize());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://d365-job-hunter-app.vercel.app/auth/callback"
}, (accessToken, refreshToken, profile, done) => {
  return done(null, {
    id: profile.id,
    displayName: profile.displayName,
    email: profile.emails[0].value,
    accessToken,
    refreshToken
  });
}));

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

async function getLinkedInPosts() {
  try {
    if (!LINKEDIN_BIN_ID) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    return Array.isArray(data.record) ? data.record.filter(p => !p.init) : [];
  } catch(e) {
    return [];
  }
}

app.get("/", async (req, res) => {
  const candidates = await getCandidates();
  const posts = await getLinkedInPosts();
  const emailsSent = posts.reduce((sum, p) => sum + (p.emailsSent || 0), 0);
  res.render("index", { user: req.user, candidateCount: candidates.length, emailsSent });
});

app.get("/dashboard", async (req, res) => {
  if (!req.user) return res.redirect("/");
  const candidates = await getCandidates();
  const me = candidates.find(c => c.email === req.user.email);
  const posts = await getLinkedInPosts();
  res.render("dashboard", {
    user: req.user,
    candidate: me,
    candidates,
    posts,
    sheetUrl: process.env.GOOGLE_SHEET_ID
      ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`
      : "https://docs.google.com/spreadsheets/d/1DZpavtALZ0lyAPbeSEUbsfna3COIumHPWP_G-q8UziY"
  });
});

app.get("/register", (req, res) => {
  res.render("register", { user: req.user, error: req.query.error || null });
});

app.post("/register", upload.single("resume"), async (req, res) => {
  if (!req.user) return res.redirect("/auth/google");
  if (!req.file) return res.redirect("/register?error=Please upload your resume");

  try {
    const { put } = require("@vercel/blob");
    const candidateId = req.user.id;
    const fileExt = req.file.originalname.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';

    // STEP 1: Upload resume to Vercel Blob
    const blob = await put(
      `resumes/${candidateId}/resume.${fileExt}`,
      req.file.buffer,
      {
        access: 'public',
        contentType: req.file.mimetype,
        addRandomSuffix: true,
        token: process.env.BLOB_READ_WRITE_TOKEN
      }
    );

    // STEP 2: Extract text from resume
    let resumeText = "";
    try {
      if (fileExt === 'pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(req.file.buffer);
        resumeText = pdfData.text.substring(0, 3000);
      } else {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        resumeText = result.value.substring(0, 3000);
      }
    } catch(e) {
      console.log("Resume text extraction error:", e.message);
    }

    // STEP 3: Extract candidate profile using Groq AI
    let parsedDetails = {};
    if (resumeText) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const response = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{
            role: "user",
            content: `Extract details from this resume. Return ONLY valid JSON with no explanation:

"${resumeText}"

{
  "phone": "phone number or empty string",
  "linkedin": "linkedin URL or empty string",
  "skills": ["skill1", "skill2", "skill3", "skill4", "skill5"],
  "clients": "key clients or projects worked on",
  "summary": "2 sentence professional summary",
  "certifications": "certifications if any or empty string",
  "currentRole": "most recent job title"
}`
          }],
          max_tokens: 500
        });
        const text = response.choices[0].message.content;
        const json = text.match(/\{[\s\S]*\}/)?.[0];
        if (json) parsedDetails = JSON.parse(json);
      } catch(e) {
        console.log("Groq parse error:", e.message);
      }
    }

    // STEP 4: Save to JSONBin
    await saveCandidate({
      id: candidateId,
      name: req.body.name || req.user.displayName,
      email: req.user.email,
      experience: req.body.experience,
      role: req.body.role || parsedDetails.currentRole || "",
      accessToken: req.user.accessToken,
      refreshToken: req.user.refreshToken,
      phone: parsedDetails.phone || "",
      linkedin: parsedDetails.linkedin || "",
      skills: parsedDetails.skills || [],
      clients: parsedDetails.clients || "",
      summary: parsedDetails.summary || "",
      certifications: parsedDetails.certifications || "",
      resumeText: resumeText.substring(0, 2000),
      resume: {
        pathname: blob.pathname,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        url: blob.url
      },
      registeredAt: new Date().toISOString()
    });

    res.redirect("/dashboard");
  } catch(e) {
    console.error("Registration error:", e);
    res.redirect("/register?error=Registration failed: " + e.message);
  }
});

app.get("/auth/google", passport.authenticate("google", {
  scope: ["profile", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/spreadsheets"],
  accessType: "offline",
  prompt: "consent"
}));

app.get("/auth/callback", passport.authenticate("google", {
  failureRedirect: "/",
  session: false
}), async (req, res) => {
  try {
    const sessionId = await createSession({
      id: req.user.id,
      displayName: req.user.displayName,
      email: req.user.email,
      accessToken: req.user.accessToken,
      refreshToken: req.user.refreshToken
    });
    res.setHeader("Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Max-Age=${60*60*24*30}; Path=/; HttpOnly; SameSite=Lax`
    );
    console.log("Session created:", sessionId.substring(0, 10) + "...");
    res.redirect("/dashboard");
  } catch(e) {
    console.error("Session creation error:", e);
    res.redirect("/");
  }
});

app.get("/logout", async (req, res) => {
  try {
    if (req.sessionId) await destroySession(req.sessionId);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  } catch(e) {}
  res.redirect("/");
});

// /api/candidates, /api/history, /api/session-check, /api/run-now are NOT
// defined here. On Vercel, any request under /api/* is routed to a matching
// file in the api/ directory BEFORE it ever reaches this Express app - a
// route registered only inside server.js under an /api/ path is unreachable
// in production, no matter what it does. Those four now live as their own
// files: api/candidates.js, api/history.js, api/session-check.js,
// api/run-now.js. Do not re-add them here.

// Post Job tab: parses a pasted post/image and instantly emails all candidates
app.post("/linkedin/submit", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  try {
    const triggerHandler = require("./api/trigger-emails");
    await triggerHandler(req, res);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
  });
}

module.exports = app;
