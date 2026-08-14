const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const emailSender = require('./emailSender');
const sheetUpdater = require('./sheetUpdater');

const candidatesPath = path.join(__dirname, '../data/candidates.json');
const statsPath = path.join(__dirname, '../data/stats.json');

// Logging helper that writes to stats.json
function logMessage(message) {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const formattedLog = `[${timestamp}] ${message}`;
  console.log(formattedLog);

  let stats = { emailsSentToday: 0, jobsScraped: 0, logs: [] };
  if (fs.existsSync(statsPath)) {
    try {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {}
  }
  
  if (!stats.logs) stats.logs = [];
  stats.logs.push(formattedLog);
  // Keep last 100 logs
  if (stats.logs.length > 100) stats.logs.shift();
  
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
}

// Check if email was already sent to this company for this candidate today
function isDuplicateCompanyToday(candidateId, companyName) {
  let stats = { emailsSentToday: 0, jobsScraped: 0, logs: [] };
  if (fs.existsSync(statsPath)) {
    try {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {}
  }
  
  if (!stats.sentCompaniesToday) stats.sentCompaniesToday = {};
  const todayStr = new Date().toISOString().split('T')[0];
  
  const key = `${todayStr}_${candidateId}_${companyName.toLowerCase().trim()}`;
  if (stats.sentCompaniesToday[key]) {
    return true;
  }
  return false;
}

// Mark company as emailed today for this candidate
function markCompanyAsEmailedToday(candidateId, companyName) {
  let stats = { emailsSentToday: 0, jobsScraped: 0, logs: [] };
  if (fs.existsSync(statsPath)) {
    try {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {}
  }
  
  if (!stats.sentCompaniesToday) stats.sentCompaniesToday = {};
  const todayStr = new Date().toISOString().split('T')[0];
  const key = `${todayStr}_${candidateId}_${companyName.toLowerCase().trim()}`;
  stats.sentCompaniesToday[key] = true;
  
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
}

// Main execution logic
async function runCampaign() {
  logMessage('Campaign triggered.');

  // 1. Read Candidates
  let candidates = [];
  if (fs.existsSync(candidatesPath)) {
    try {
      candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    } catch (e) {}
  }

  if (candidates.length === 0) {
    logMessage('No candidates registered. Stopping campaign.');
    return;
  }

  // Reset daily stats if it is a new day
  let stats = { emailsSentToday: 0, jobsScraped: 0, logs: [], lastRunDate: '' };
  if (fs.existsSync(statsPath)) {
    try {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {}
  }
  const todayStr = new Date().toISOString().split('T')[0];
  if (stats.lastRunDate !== todayStr) {
    stats.emailsSentToday = 0;
    stats.lastRunDate = todayStr;
    stats.sentCompaniesToday = {}; // clear daily tracker
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  }

  // 2. Run Job Scraper Python script
  const scraperScript = path.join(__dirname, 'scraper.py');
  
  // Use 'python' or 'python3' based on OS, default to python
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  
  logMessage('Executing Python scraper...');
  
  exec(`"${pythonCmd}" "${scraperScript}"`, async (error, stdout, stderr) => {
    if (error) {
      logMessage(`Scraper execution error: ${error.message}`);
      return;
    }
    
    let jobs = [];
    try {
      jobs = JSON.parse(stdout);
    } catch (e) {
      logMessage('Failed to parse scraper output. Check python setup.');
      console.log('Raw output:', stdout);
      return;
    }

    logMessage(`Scraper finished. Found ${jobs.length} relevant D365 jobs.`);
    
    // Update scraped count
    stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    stats.jobsScraped = jobs.length;
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

    // 3. Process jobs
    for (const job of jobs) {
      logMessage(`Processing Job: "${job.title}" at "${job.company}"`);

      // Find HR Email
      const hrContact = await emailSender.findHREmail(job.company);
      if (!hrContact) {
        logMessage(`Skipping "${job.company}" - no valid individual HR email found.`);
        continue;
      }

      // Loop through all registered candidates
      for (const candidate of candidates) {
        if (!candidate.gmailConnected) {
          logMessage(`Candidate ${candidate.name} is missing Gmail OAuth. Skipping.`);
          continue;
        }

        // Check daily duplicate
        if (isDuplicateCompanyToday(candidate.id, job.company)) {
          logMessage(`Duplicate check: ${candidate.name} already applied to ${job.company} today. Skipping.`);
          continue;
        }

        try {
          logMessage(`Drafting application for ${candidate.name} to ${job.company} (${hrContact.email})`);
          
          // Read resume content
          const resumePath = path.join(__dirname, '../data/resumes/', candidate.resumeFilename);
          const resumeText = await emailSender.extractResumeText(resumePath);

          // Generate Pitch
          const pitch = await emailSender.generatePitch(candidate, job.description || '', resumeText);

          // Send Email
          await emailSender.sendGmailEmail(candidate, hrContact.email, pitch.subject, pitch.body);
          
          logMessage(`Email sent successfully for ${candidate.name} to ${hrContact.email}`);

          // Track email sent
          candidate.emailsSentCount = (candidate.emailsSentCount || 0) + 1;
          
          // Update Sheet
          await sheetUpdater.appendSheetRow(candidate, job, hrContact.email, true);
          
          // Track daily sends
          stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
          stats.emailsSentToday = (stats.emailsSentToday || 0) + 1;
          fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

          // Mark company as emailed
          markCompanyAsEmailedToday(candidate.id, job.company);

        } catch (err) {
          logMessage(`Failed to apply for ${candidate.name} to ${job.company}: ${err.message}`);
          await sheetUpdater.appendSheetRow(candidate, job, hrContact.email, false);
        }
      }
    }

    // 4. Save candidates update
    fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));

    // 5. Parse LinkedIn Posts tab from spreadsheet
    logMessage('Processing LinkedIn Posts tab...');
    await sheetUpdater.processLinkedInPostsTab(candidates, emailSender);
    
    logMessage('Campaign cycle completed.');
  });
}

module.exports = {
  runCampaign,
  logMessage
};
