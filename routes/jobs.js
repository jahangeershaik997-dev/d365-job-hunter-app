const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const scheduler = require('../scripts/scheduler');
const emailSender = require('../scripts/emailSender');
const sheetUpdater = require('../scripts/sheetUpdater');

const candidatesPath = path.join(__dirname, '../data/candidates.json');

// Manually trigger job scraper campaign
router.post('/scrape', (req, res) => {
  // Run asynchronously
  scheduler.runCampaign().catch(err => {
    console.error('Error in manual campaign trigger:', err);
  });
  
  res.redirect('/dashboard?success=Scraper campaign started in background. Monitor logs below.');
});

// Process pasted recruiter text from dashboard
router.post('/linkedin-parse', async (req, res) => {
  const { candidateId, postText } = req.body;
  if (!candidateId || !postText) {
    return res.redirect('/dashboard?error=Missing candidate selection or post content.');
  }

  try {
    // 1. Find candidate
    let candidates = [];
    if (fs.existsSync(candidatesPath)) {
      candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    }

    const candidate = candidates.find(c => c.id === candidateId);
    if (!candidate) {
      return res.redirect('/dashboard?error=Candidate not found.');
    }

    scheduler.logMessage(`[Manual Job Parse] Processing post for ${candidate.name}`);

    // 2. Parse recruiter text
    const parsedJob = await sheetUpdater.parseLinkedInPostText(postText);
    if (!parsedJob) {
      return res.redirect('/dashboard?error=Could not parse details from the text.');
    }

    if (!parsedJob.hr_email) {
      scheduler.logMessage(`[Manual Job Parse] Failed: No HR email found in text.`);
      return res.redirect('/dashboard?error=No valid HR email found in the pasted post.');
    }

    // 3. Extract resume text
    const resumePath = path.join(__dirname, '../data/resumes/', candidate.resumeFilename);
    const resumeText = await emailSender.extractResumeText(resumePath);

    // 4. Generate pitch
    const pitch = await emailSender.generatePitch(candidate, parsedJob.description || postText, resumeText);

    // 5. Send Gmail
    await emailSender.sendGmailEmail(candidate, parsedJob.hr_email, pitch.subject, pitch.body);
    scheduler.logMessage(`[Manual Job Parse] Email sent successfully from ${candidate.name} to ${parsedJob.hr_email}`);

    // 6. Update spreadsheet tracker
    await sheetUpdater.appendSheetRow(candidate, parsedJob, parsedJob.hr_email, true);

    // 7. Update candidate emails sent count
    candidate.emailsSentCount = (candidate.emailsSentCount || 0) + 1;
    fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));

    res.redirect('/dashboard?success=Application sent successfully!');
  } catch (error) {
    console.error('LinkedIn parse error:', error);
    res.redirect(`/dashboard?error=Failed to process post: ${error.message}`);
  }
});

module.exports = router;
