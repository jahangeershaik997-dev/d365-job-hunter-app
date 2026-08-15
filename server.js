const express = require("express");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");
const Groq = require("groq-sdk");

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

  try {
    const { put } = require("@vercel/blob");
    const candidateId = req.user.id;
    const fileExt = req.file.originalname.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';

    // STEP 1: Upload resume to Vercel Blob
    const blob = await put(
      `resumes/${candidateId}/resume.${fileExt}`,
      req.file.buffer,
      {
        access: 'private',
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
        const Groq = require("groq-sdk");
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
      email: req.user.emails[0].value,
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

app.get("/dashboard", async (req, res) => {
  if (!req.user) return res.redirect("/");
  const candidates = await getCandidates();
  const me = candidates.find(c => c.email === req.user.emails[0].value);
  res.render("dashboard", { user: req.user, candidate: me, candidates });
});

app.get("/auth/google", passport.authenticate("google", {
  scope: ["profile", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/spreadsheets"],
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
// ADD THESE ROUTES TO server.js

const LINKEDIN_BIN_ID_SRV = process.env.LINKEDIN_BIN_ID;
const JSONBIN_MK_SRV = process.env.JSONBIN_MASTER_KEY;

async function getLinkedInPostsSrv() {
  try {
    if (!LINKEDIN_BIN_ID_SRV) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID_SRV}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MK_SRV }
    });
    const data = await res.json();
    return Array.isArray(data.record) ? data.record.filter(p => !p.init) : [];
  } catch(e) { return []; }
}

app.get("/linkedin", async (req, res) => {
  const posts = await getLinkedInPostsSrv();
  res.render("linkedin", { user: req.user, posts, success: req.query.success || false });
});

// INSTANT TRIGGER - calls the API internally
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

// ============================================================
// LINKEDIN POSTS ROUTES
// ============================================================
const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;
const JSONBIN_MASTER_KEY_LI = process.env.JSONBIN_MASTER_KEY;

async function getLinkedInPosts() {
  try {
    if (!LINKEDIN_BIN_ID) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY_LI }
    });
    const data = await res.json();
    return Array.isArray(data.record) ? data.record : [];
  } catch(e) { return []; }
}

async function saveLinkedInPost(post) {
  const posts = await getLinkedInPosts();
  posts.unshift(post);
  await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_MASTER_KEY_LI },
    body: JSON.stringify(posts)
  });
}

app.get("/linkedin", async (req, res) => {
  const posts = await getLinkedInPosts();
  res.render("linkedin", {
    user: req.user,
    posts,
    success: req.query.success || false
  });
});

app.post("/linkedin", async (req, res) => {
  if (!req.user) return res.redirect("/auth/google");
  await saveLinkedInPost({
    text: req.body.text,
    email: req.body.email || null,
    url: req.body.url || null,
    company: null,
    processed: false,
    addedBy: req.user.emails[0].value,
    addedAt: new Date().toISOString()
  });
  res.redirect("/linkedin?success=true");
});
