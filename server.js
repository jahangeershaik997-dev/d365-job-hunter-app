require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const jobsRoutes = require('./routes/jobs');
const scheduler = require('./scripts/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Verify / Create necessary data folders
const resumesDir = path.join(__dirname, 'data/resumes');
if (!fs.existsSync(resumesDir)) {
  fs.mkdirSync(resumesDir, { recursive: true });
}

// Multer configurations for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, resumesDir);
  },
  filename: (req, file, cb) => {
    const candidateName = req.body.name ? req.body.name.replace(/\s+/g, '_') : 'candidate';
    const timestamp = Date.now();
    cb(null, `${candidateName}_${timestamp}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.docx') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and DOCX documents are allowed!'), false);
    }
  }
});

// Settings & Middlewares
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'd365jobhunterdefaultsecret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// Route Middlewares
app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/jobs', jobsRoutes);

// Home route
app.get('/', (req, res) => {
  let candidatesCount = 0;
  try {
    const candidatesPath = path.join(__dirname, 'data/candidates.json');
    if (fs.existsSync(candidatesPath)) {
      const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
      candidatesCount = candidates.length;
    }
  } catch (e) {}

  let stats = { emailsSentToday: 0, jobsScraped: 0 };
  try {
    const statsPath = path.join(__dirname, 'data/stats.json');
    if (fs.existsSync(statsPath)) {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }
  } catch (e) {}

  res.render('index', {
    stats: {
      candidatesCount: candidatesCount,
      emailsSentToday: stats.emailsSentToday || 0,
      jobsScraped: stats.jobsScraped || 0
    }
  });
});

// Candidate onboarding page
app.get('/register', (req, res) => {
  res.render('register', { error: req.query.error || null });
});

// Candidate form submission - holds details in session then redirects to Google OAuth
app.post('/register', upload.single('resume'), (req, res) => {
  if (!req.file) {
    return res.redirect('/register?error=Please upload a valid resume.');
  }

  req.session.pendingCandidate = {
    name: req.body.name,
    role: req.body.role,
    experience: req.body.experience,
    resumeFilename: req.file.filename
  };

  res.redirect('/auth/google');
});

// View/Download Resume endpoint
app.get('/resumes/:candidateId', (req, res) => {
  try {
    const candidatesPath = path.join(__dirname, 'data/candidates.json');
    if (!fs.existsSync(candidatesPath)) {
      return res.status(404).send('No candidates registered.');
    }
    const candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    const candidate = candidates.find(c => c.id === req.params.candidateId);
    
    if (!candidate || !candidate.resumeFilename) {
      return res.status(404).send('Resume not found.');
    }

    const filePath = path.join(resumesDir, candidate.resumeFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Resume file missing on server.');
    }

    res.sendFile(filePath);
  } catch (error) {
    res.status(500).send('Internal server error.');
  }
});

// Daily 9 AM IST scheduler
cron.schedule('0 9 * * *', () => {
  scheduler.logMessage('[Scheduler] Executing daily 9:00 AM IST job scrape and application run...');
  scheduler.runCampaign().catch(err => {
    scheduler.logMessage(`[Scheduler] Automation failed: ${err.message}`);
  });
}, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

app.listen(PORT, () => {
  console.log(`D365 Job Hunter running at: http://localhost:${PORT}`);
  scheduler.logMessage(`System started up. Listening on port ${PORT}`);
});
