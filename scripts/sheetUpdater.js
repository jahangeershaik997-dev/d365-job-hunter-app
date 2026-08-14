const { google } = require('googleapis');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Get authorized sheets client
function getSheetsClient(candidate) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
  oauth2Client.setCredentials(candidate.tokens);
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

// Append Row to Job Sent Tracker
async function appendSheetRow(candidate, job, hrEmail, isSent) {
  try {
    const sheets = getSheetsClient(candidate);
    const dateStr = new Date().toISOString().split('T')[0];
    
    // Columns: Job Title, Company, Location, URL, Source, HR Email, Candidate, Sent, Date, Status
    const values = [[
      job.title || 'Dynamics 365 Developer',
      job.company || 'Unknown Company',
      job.location || 'Remote',
      job.job_url || '',
      job.source || 'indeed',
      hrEmail || 'N/A',
      candidate.name,
      isSent ? 'Yes' : 'No',
      dateStr,
      isSent ? 'Emailed' : 'Skipped/No HR Email'
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    console.log(`[Sheets] Appended job application row for ${candidate.name} to Sheet1.`);
  } catch (error) {
    console.error('[Sheets] Error appending row:', error.message);
  }
}

// Parse LinkedIn recruiter post text via Groq AI
async function parseLinkedInPostText(postText) {
  const prompt = `
You are an AI assistant parsing recruiter posts from LinkedIn. Extract the job details.
Post Text:
"""
${postText}
"""

Extract the following information and output strictly in JSON format:
{
  "title": "Job Title (default to 'Dynamics 365 Developer' if not clear)",
  "company": "Company Name (default to 'Recruiter Network' if not clear)",
  "location": "Location (default to 'Remote' if not clear)",
  "hr_email": "Extracted email address (MUST be a name-based email like name@company.com. If not present or only generic like hr@, leave empty)",
  "description": "Short parsed summary of the role"
}
`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama3-8b-8192',
      response_format: { type: 'json_object' }
    });

    return JSON.parse(chatCompletion.choices[0].message.content);
  } catch (error) {
    console.error('[Groq] Error parsing LinkedIn post text:', error);
    return null;
  }
}

// Read and process the "LinkedIn Posts" tab
async function processLinkedInPostsTab(candidates, emailSenderHelper) {
  if (candidates.length === 0) {
    console.log('[Sheets] No candidates registered to process LinkedIn posts.');
    return;
  }

  // Use the first candidate's credentials to read/write sheets
  const masterCandidate = candidates[0];
  const sheets = getSheetsClient(masterCandidate);

  try {
    console.log('[Sheets] Checking "LinkedIn Posts" sheet tab...');
    
    // Fetch values from "LinkedIn Posts" tab
    // Columns are assumed to be: A: Candidate Email/Name, B: Recruiter Post Text, C: Status
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'LinkedIn Posts!A2:C100'
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('[Sheets] No rows found in "LinkedIn Posts" tab.');
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const candidateIdentifier = row[0]; // Candidate Name or Email
      const postText = row[1];
      const status = row[2];

      if (!postText || (status && status.toLowerCase() === 'processed')) {
        continue;
      }

      console.log(`[Sheets] Processing row ${i + 2}: ${candidateIdentifier}`);

      // Find matching candidate
      const targetCandidate = candidates.find(c => 
        c.email.toLowerCase() === candidateIdentifier.toLowerCase() || 
        c.name.toLowerCase() === candidateIdentifier.toLowerCase()
      );

      if (!targetCandidate) {
        console.log(`[Sheets] Candidate "${candidateIdentifier}" not found. Skipping.`);
        continue;
      }

      // Parse post text
      const parsedJob = await parseLinkedInPostText(postText);
      if (!parsedJob) {
        continue;
      }

      if (!parsedJob.hr_email) {
        console.log(`[Sheets] No valid HR email parsed from post. Skipping row.`);
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `LinkedIn Posts!C${i + 2}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['Failed: No Email']] }
        });
        continue;
      }

      // Process Application
      console.log(`[LinkedIn Tab] Sending application for ${targetCandidate.name} to ${parsedJob.hr_email}`);
      const resumeText = await emailSenderHelper.extractResumeText(
        path.join(__dirname, '../data/resumes/', targetCandidate.resumeFilename)
      );

      const pitch = await emailSenderHelper.generatePitch(targetCandidate, parsedJob.description || postText, resumeText);
      await emailSenderHelper.sendGmailEmail(targetCandidate, parsedJob.hr_email, pitch.subject, pitch.body);

      // Log sent status to Sheet1 tracker
      await appendSheetRow(targetCandidate, parsedJob, parsedJob.hr_email, true);

      // Update candidate's count
      targetCandidate.emailsSentCount = (targetCandidate.emailsSentCount || 0) + 1;

      // Update status in "LinkedIn Posts" tab
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `LinkedIn Posts!C${i + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Processed']] }
      });

      console.log(`[Sheets] Row ${i + 2} successfully processed.`);
    }

    // Save candidate list updates
    const candidatesPath = path.join(__dirname, '../data/candidates.json');
    fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));

  } catch (error) {
    console.error('[Sheets] Error processing LinkedIn Posts tab:', error.message);
  }
}

module.exports = {
  appendSheetRow,
  parseLinkedInPostText,
  processLinkedInPostsTab
};
