const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Groq = require('groq-sdk');
const { google } = require('googleapis');

// Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper to extract text from Resume
async function extractResumeText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else {
    throw new Error('Unsupported resume format: ' + ext);
  }
}

// Find HR email via Apollo.io API
async function findHREmail(companyName) {
  try {
    console.log(`[Apollo] Looking up HR for company: "${companyName}"`);
    
    const response = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
      api_key: process.env.APOLLO_API_KEY,
      organization_names: [companyName],
      person_titles: ['hr', 'recruiter', 'talent acquisition', 'human resources', 'talent partner', 'recruitment consultant'],
      page: 1,
      per_page: 5
    });

    if (response.data && response.data.people && response.data.people.length > 0) {
      for (const person of response.data.people) {
        const email = person.email;
        if (email && isValidHREmail(email)) {
          console.log(`[Apollo] Found HR email: ${email} (${person.name || 'Unknown'})`);
          return { email, name: person.name || 'HR Team' };
        }
      }
    }
    console.log(`[Apollo] No individual name-based HR email found for: ${companyName}`);
    return null;
  } catch (error) {
    console.error(`[Apollo] Error looking up ${companyName}:`, error.message);
    return null;
  }
}

// Validate individual HR email format name@company.com (skip generic/roles)
function isValidHREmail(email) {
  const emailLower = email.toLowerCase();
  
  // Generic list to skip
  const genericList = [
    'hr@', 'info@', 'careers@', 'recruitment@', 'recruiting@', 'jobs@', 
    'contact@', 'support@', 'sales@', 'admin@', 'office@', 'hello@', 'talent@'
  ];
  
  if (genericList.some(generic => emailLower.startsWith(generic))) {
    return false;
  }
  
  // Must match standard email format and ideally contain a name dot/hyphen pattern or just standard format
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(emailLower)) {
    return false;
  }
  
  return true;
}

// Generate Personalized Pitch via Groq AI
async function generatePitch(candidate, jobDescription, resumeText) {
  const years = parseInt(candidate.experience, 10);
  
  // Different tone prompts
  let toneInstruction = '';
  if (years >= 7) {
    toneInstruction = 'Use an authoritative, strategic, senior tone. Highlight your architectural decisions, system reliability, leadership, and ability to steer Dynamics 365 / CRM projects.';
  } else {
    toneInstruction = 'Use an exciting, hungry, proactive, and highly professional tone. Focus on your hands-on execution, rapid contribution, problem-solving abilities, and passion for Dynamics 365 development.';
  }

  const prompt = `
You are a career consultant drafting a highly personalized job application email for a candidate applying to a Dynamics 365 (D365) role.
Candidate Name: ${candidate.name}
Candidate Role: ${candidate.role}
Years of Experience: ${candidate.experience}

${toneInstruction}

Candidate Resume Details:
"""
${resumeText.substring(0, 3000)}
"""

Job Description:
"""
${jobDescription.substring(0, 3000)}
"""

Write a short, engaging, and professional cold outreach email to the recruiter. 
Return the output strictly in the following JSON format:
{
  "subject": "Email Subject Line",
  "body": "Email Body text. Do not use placeholders like [Candidate Name] or [Company Name] in the final text. Ensure all fields are filled with actual values."
}
`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama3-8b-8192',
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(chatCompletion.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('[Groq] Error generating pitch:', error);
    return {
      subject: `Dynamics 365 Application - ${candidate.name}`,
      body: `Hello,\n\nI am reaching out to express my interest in the Dynamics 365 role at your organization. With my experience as a ${candidate.role}, I believe I can bring significant value to your team.\n\nAttached is my resume for your review.\n\nBest regards,\n${candidate.name}`
    };
  }
}

// Construct MIME Message with Attachment
function createMimeMessage({ to, from, replyTo, subject, body, attachmentPath, attachmentName }) {
  const boundary = '__custom_boundary__';
  const fileContent = fs.readFileSync(attachmentPath).toString('base64');
  
  const headers = [
    `To: ${to}`,
    `From: ${from}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
    '',
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    '',
    fileContent,
    '',
    `--${boundary}--`
  ];

  return Buffer.from(headers.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Send Email via Candidate's Gmail
async function sendGmailEmail(candidate, toEmail, subject, body) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
  
  oauth2Client.setCredentials(candidate.tokens);
  
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  const resumePath = path.join(__dirname, '../data/resumes/', candidate.resumeFilename);
  const ext = path.extname(resumePath);
  const attachmentName = `${candidate.name.replace(/\s+/g, '_')}_Resume${ext}`;

  const rawMime = createMimeMessage({
    to: toEmail,
    from: `"${candidate.name}" <${candidate.email}>`,
    replyTo: candidate.email,
    subject: subject,
    body: body,
    attachmentPath: resumePath,
    attachmentName: attachmentName
  });

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: rawMime
    }
  });
}

module.exports = {
  extractResumeText,
  findHREmail,
  generatePitch,
  sendGmailEmail
};
