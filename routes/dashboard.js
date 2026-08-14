const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const candidatesPath = path.join(__dirname, '../data/candidates.json');
const statsPath = path.join(__dirname, '../data/stats.json');

// Helper to get stats
function getStats() {
  if (fs.existsSync(statsPath)) {
    try {
      return JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {
      // Return defaults if malformed
    }
  }
  return {
    emailsSentToday: 0,
    jobsScraped: 0,
    logs: ["[SYSTEM] System initialized successfully."]
  };
}

router.get('/', (req, res) => {
  let candidates = [];
  if (fs.existsSync(candidatesPath)) {
    try {
      candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    } catch (e) {
      console.error('Error parsing candidates.json:', e);
    }
  }

  const stats = getStats();

  res.render('dashboard', {
    candidates: candidates,
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    logs: stats.logs ? stats.logs.slice(-15) : [], // Show last 15 logs
    successMsg: req.query.success || null,
    errorMsg: req.query.error || null
  });
});

module.exports = router;
