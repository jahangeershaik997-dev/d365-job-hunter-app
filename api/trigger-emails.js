const { google } = require("googleapis");
const Groq = require("groq-sdk");

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_REFRESH_TOKEN = process.env.SHEET_REFRESH_TOKEN;
const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;

async function getCandidates() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
  });
  const data = await res.json();
  return Array.isArray(data.record) ? data.record.filter(c => !c.init && c.refreshToken) : [];
}

// STRICT real person email only
function isRealPersonEmail(email) {
  if (!email) return false;
  const local = email.split("@")[0].toLowerCase();
  const blacklist = ["hr", "careers", "career", "recruitment", "recruit", "jobs", "job",
    "info", "contact", "admin", "support", "hello", "team", "talent", "india",
    "noreply", "no-reply", "hiring", "apply", "applications", "application",
    "staffing", "staff", "people", "humanresources", "acquisition", "resumes",
    "resume", "work", "opportunity", "connect", "recruiting"];
  const parts = local.split(".");
  for (const part of parts) {
    if (blacklist.includes(part)) return false;
  }
  if (!local.includes(".")) return false;
  for (const part of parts) {
    if (part.length < 2) return false;
    if (!/^[a-z]+$/.test(part)) return false;
  }
  return true;
}

async function parseJobPost(text, groq) {
  const prompt = `Extract job details from this post. Return ONLY valid JSON:

"${text.substring(0, 500)}"

{
  "title": "exact job title",
  "company": "company name",
  "location": "city or India",
  "recruiterName": "first name if mentioned else null",
  "recruiterEmail": "email if mentioned else null",
  "skills": "key technical skills required",
  "experience": "years of experience required"
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300
  });

  try {
    const text2 = response.choices[0].message.content;
    const json = text2.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) { return null; }
}

async function parseImagePost(imageBase64, groq) {
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: imageBase64 }
          },
          {
            type: "text",
            text: `Extract job details from this image. Return ONLY valid JSON:
{
  "title": "job title",
  "company": "company name", 
  "location": "location",
  "recruiterName": "recruiter name if visible",
  "recruiterEmail": "email if visible else null",
  "skills": "skills required",
  "experience": "years required"
}`
          }
        ]
      }],
      max_tokens: 300
    });

    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) {
    console.log("Image parse error:", e.message);
    return null;
  }
}

async function generateEmail(candidate, job, groq, recruiterName = null) {
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";

  const prompt = `Write a CONFIDENT, POLITE and ATTRACTIVE job application email.

Candidate: ${candidate.name}
Experience: ${candidate.experience} years Microsoft Dynamics 365 CRM Developer  
Role: ${candidate.role}
Skills: C#.NET plugins, Power Platform, Azure Functions, Azure DevOps, JavaScript, FetchXML, Ribbon Workbench

Job: ${job.title} at ${job.company}
Location: ${job.location}
Requirements: ${job.skills || job.description || ''}

Rules:
- Greeting: "${greeting},"
- CONFIDENT and PROFESSIONAL (not desperate or begging)
- Mention ${candidate.experience} years experience naturally
- Highlight 2-3 skills matching the job
- Show genuine interest in ${job.company}
- Clear call to action at end
- Max 120 words
- Make it stand out!

Write:
SUBJECT: [compelling subject]

BODY:
[email]`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500
  });

  const text = response.choices[0].message.content;
  if (text.includes("SUBJECT:") && text.includes("BODY:")) {
    return {
      subject: text.split("SUBJECT:")[1].split("BODY:")[0].trim(),
      body: text.split("BODY:")[1].trim()
    };
  }

  return {
    subject: `${candidate.experience}+ Years D365 Expert | Application for ${job.title} - ${candidate.name}`,
    body: `${greeting},\n\nI am writing to express my strong interest in the ${job.title} position at ${job.company}. With ${candidate.experience}+ years of Microsoft Dynamics 365 CRM development experience, I have delivered enterprise solutions involving C#.NET plugins, Power Platform, and Azure DevOps CI/CD pipelines.\n\nI am confident in adding immediate value to your team and would welcome the opportunity to discuss further.\n\nBest regards,\n${candidate.name}\n✉️ ${candidate.email}`
  };
}

async function sendGmail(candidate, to, subject, body) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://d365-job-hunter-app.vercel.app/auth/callback"
  );
  oauth2Client.setCredentials({ refresh_token: candidate.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const message = [
    `From: ${candidate.name} <${candidate.email}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(message).toString("base64url") }
  });
}

async function updateSheet(candidate, job, hrEmail, subject, sent) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      "https://d365-job-hunter-app.vercel.app/auth/callback"
    );
    oauth2Client.setCredentials({ refresh_token: SHEET_REFRESH_TOKEN });
    const sheets = google.sheets({ version: "v4", auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:K",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          job.title, job.company, job.location, job.url || "",
          "LinkedIn Post", hrEmail, candidate.name,
          subject, sent ? "Yes" : "No",
          new Date().toLocaleDateString("en-IN"), "Applied"
        ]]
      }
    });
  } catch(e) {
    console.log("Sheet error:", e.message);
  }
}

async function saveToLinkedInBin(post) {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    const posts = Array.isArray(data.record) ? data.record : [];
    posts.unshift(post);
    await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_MASTER_KEY },
      body: JSON.stringify(posts.slice(0, 50))
    });
  } catch(e) {}
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, imageBase64, email, url, type } = req.body;
  const groq = new Groq({ apiKey: GROQ_API_KEY });
  const results = [];

  try {
    const candidates = await getCandidates();
    if (candidates.length === 0) return res.json({ success: false, error: "No candidates registered" });

    // Parse job details
    let jobDetails = null;
    if (type === "image" && imageBase64) {
      jobDetails = await parseImagePost(imageBase64, groq);
    } else if (text) {
      jobDetails = await parseJobPost(text, groq);
    }

    if (!jobDetails) return res.json({ success: false, error: "Could not parse job details" });

    // Get HR email
    const hrEmail = (email && isRealPersonEmail(email)) ? email :
                    (jobDetails.recruiterEmail && isRealPersonEmail(jobDetails.recruiterEmail)) ? jobDetails.recruiterEmail : null;

    const job = {
      title: jobDetails.title || "D365 Developer",
      company: jobDetails.company || "Company",
      location: jobDetails.location || "India",
      url: url || "",
      skills: jobDetails.skills || text?.substring(0, 200)
    };

    // Save to LinkedIn bin
    await saveToLinkedInBin({
      text: text || "Image post",
      company: job.company,
      hrEmail,
      url,
      processed: true,
      emailsSent: candidates.length,
      addedAt: new Date().toISOString()
    });

    if (!hrEmail) {
      return res.json({
        success: false,
        error: "No real person HR email found. Please add the recruiter's email (firstname.lastname@company.com format)",
        jobDetails
      });
    }

    // Send emails from ALL candidates
    for (const candidate of candidates) {
      try {
        const { subject, body } = await generateEmail(candidate, job, groq, jobDetails.recruiterName);
        let sent = false;
        try {
          await sendGmail(candidate, hrEmail, subject, body);
          sent = true;
          console.log(`✅ ${candidate.name} → ${hrEmail}`);
        } catch(e) {
          console.log(`❌ ${candidate.name}:`, e.message);
        }
        await updateSheet(candidate, job, hrEmail, subject, sent);
        results.push({ candidate: candidate.name, company: job.company, hrEmail, sent });
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.log(`Error ${candidate.name}:`, e.message);
        results.push({ candidate: candidate.name, company: job.company, hrEmail, sent: false });
      }
    }

    res.json({
      success: true,
      jobDetails,
      hrEmail,
      emailsSent: results.filter(r => r.sent).length,
      totalCandidates: candidates.length,
      results
    });

  } catch(e) {
    console.error("Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
};
