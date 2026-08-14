const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const candidatesPath = path.join(__dirname, '../data/candidates.json');

// Initialize Google OAuth2 Client helper
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
}

// Redirect candidates to Google for authorization
router.get('/google', (req, res) => {
  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/spreadsheets'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // crucial to get refresh token
    scope: scopes,
    prompt: 'consent' // force consent screen to ensure refresh token is returned
  });

  res.redirect(authUrl);
});

// OAuth callback landing
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect('/register?error=Google authentication failed.');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user details
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const profile = await oauth2.userinfo.get();

    const email = profile.data.email;
    const name = profile.data.name;

    // Load pending details from session
    const pendingCandidate = req.session.pendingCandidate;
    if (!pendingCandidate) {
      return res.redirect('/register?error=Session timed out. Please try again.');
    }

    // Read candidates database
    let candidates = [];
    if (fs.existsSync(candidatesPath)) {
      candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    }

    // Check if candidate already exists
    const existingIndex = candidates.findIndex(c => c.email.toLowerCase() === email.toLowerCase());

    const candidateData = {
      id: existingIndex >= 0 ? candidates[existingIndex].id : 'cand_' + Date.now(),
      name: pendingCandidate.name || name,
      role: pendingCandidate.role,
      experience: pendingCandidate.experience,
      resumeFilename: pendingCandidate.resumeFilename,
      email: email,
      gmailConnected: true,
      emailsSentCount: existingIndex >= 0 ? candidates[existingIndex].emailsSentCount || 0 : 0,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || (existingIndex >= 0 ? candidates[existingIndex].tokens.refresh_token : null),
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date
      }
    };

    if (existingIndex >= 0) {
      candidates[existingIndex] = candidateData;
    } else {
      candidates.push(candidateData);
    }

    // Save back to candidates.json
    fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));

    // Clear session
    delete req.session.pendingCandidate;

    res.redirect('/dashboard?success=Candidate onboarded successfully!');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/register?error=Authentication error: ' + error.message);
  }
});

module.exports = router;
