const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { tailorResumeText, generatePDF, uploadTailoredResume } = require("./tailor-resume");
const { saveApplication } = require("../lib/history");

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
  if (!/^[a-z][a-z.]+[a-z]$/.test(local)) return false;
  if (local.length < 3) return false;
  return true;
}

async function parseJobPost(text, groq) {
  const prompt = `Extract job details from this post. Return ONLY valid JSON:

"${text.substring(0, 600)}"

{
  "title": "exact job title",
  "company": "company name",
  "location": "city or India",
  "recruiterName": "first name only if mentioned else null",
  "recruiterEmail": "email if mentioned else null",
  "skills": ["skill1", "skill2", "skill3"],
  "experience": "years required"
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300
  });

  try {
    const t = response.choices[0].message.content;
    const json = t.match(/\{[\s\S]*\}/)?.[0];
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
          { type: "image_url", image_url: { url: imageBase64 } },
          { type: "text", text: `Extract job details from this image. Return ONLY valid JSON:
{
  "title": "job title",
  "company": "company name",
  "location": "location",
  "recruiterName": "name if visible else null",
  "recruiterEmail": "email if visible else null",
  "skills": ["skill1", "skill2", "skill3"],
  "experience": "years required"
}` }
        ]
      }],
      max_tokens: 300
    });
    const t = response.choices[0].message.content;
    const json = t.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) { return null; }
}

// ============================================================
// PERFECT EMAIL STRUCTURE:
// 1. Strong subject — role + experience
// 2. One-line intro — who you are
// 3. 2-3 key skills relevant to job
// 4. Clear CTA — ask for quick discussion
// 5. Phone + LinkedIn + Email
// ============================================================
async function generateEmail(candidate, job, groq, recruiterName = null) {
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";
  const jobSkills = Array.isArray(job.skills) ? job.skills.join(", ") :
    (job.skills || "D365 CRM development");

  const emailStyles = [
    "formal and authoritative",
    "confident and direct",
    "enthusiastic and engaging",
    "concise and impactful"
  ];

  const openings = [
    `I came across this opportunity and felt compelled to reach out`,
    `Your posting caught my attention immediately`,
    `I'm reaching out regarding the ${job.title} role`,
    `Having reviewed the requirements for this position`
  ];

  const randomStyle = emailStyles[Math.floor(Math.random() * emailStyles.length)];
  const randomOpening = openings[Math.floor(Math.random() * openings.length)];

  const prompt = `Write a UNIQUE ${randomStyle} job application email.

IMPORTANT: This email MUST be completely different in structure, tone and wording from a standard template. No two candidates should sound the same.

Opening line to use: "${randomOpening}"

CANDIDATE PROFILE:
Name: ${candidate.name}
Experience: ${candidate.experience}+ years Microsoft Dynamics 365 CRM
Phone: ${candidate.phone || 'available on request'}
Key Skills: ${Array.isArray(candidate.skills) ? candidate.skills.join(', ') : 'D365 CRM, C#.NET, Power Platform'}
Clients/Projects: ${candidate.clients || 'Enterprise CRM implementations'}
Certifications: ${candidate.certifications || ''}
Summary: ${candidate.summary || ''}
Resume highlights: ${(candidate.resumeText || '').substring(0, 400)}

JOB DETAILS:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Requirements: ${Array.isArray(job.skills) ? job.skills.join(', ') : job.skills || ''}

STRICT RULES:
- Use ONLY facts from candidate profile - NEVER invent experience
- Style: ${randomStyle}
- Opening: use the opening line provided
- Highlight 2-3 skills most relevant to THIS specific job
- Each bullet point must reference candidate's REAL experience
- Call to action must feel natural not forced
- Max 130 words
- NO generic phrases like "I am excited" or "perfect fit"
- Contact at end: 📱 ${candidate.phone || 'Available on request'} | ✉️ ${candidate.email}

EMAIL STRUCTURE:
SUBJECT: [unique compelling subject - different format each time]

BODY:
[Greeting],

[Opening line]

[One sentence who they are]

Here's what I bring:
- [Skill 1] — [real achievement from their profile]
- [Skill 2] — [real achievement from their profile]
- [Skill 3] — [real achievement from their profile]

[Unique call to action]

📱 ${candidate.phone || 'Available on request'}
✉️ ${candidate.email}

Best regards,
${candidate.name}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600
  });

  const text = response.choices[0].message.content;
  const lines = text.split("\n");
  let subject = "";
  let bodyLines = [];
  let foundSubject = false;

  for (const line of lines) {
    if (line.toLowerCase().startsWith("subject:")) {
      subject = line.replace(/^subject:\s*/i, "").trim();
      foundSubject = true;
    } else if (foundSubject) {
      if (line.trim().toLowerCase() === "body:") continue;
      bodyLines.push(line);
    }
  }

  if (!subject) {
    subject = `${candidate.experience}+ Years D365 CRM Developer | ${job.title} at ${job.company}`;
    bodyLines = text.split("\n");
  }

  return { subject, body: bodyLines.join("\n").trim() };
}

async function sendGmail(candidate, to, subject, body, job) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://d365-job-hunter-app.vercel.app/auth/callback"
  );
  oauth2Client.setCredentials({ refresh_token: candidate.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Generate tailored resume for this specific job
  let resumeBuffer = null;
  let resumeFilename = `${candidate.name.replace(/\s/g,"_")}_${job.company.replace(/\s/g,"_")}_Resume.pdf`;
  let resumeMimeType = "application/pdf";

  try {
    console.log(`📄 Tailoring resume for ${candidate.name} → ${job.company}...`);
    const tailoredData = await tailorResumeText(candidate, job);
    if (tailoredData) {
      const pdfBuffer = await generatePDF(tailoredData, candidate, job);
      if (pdfBuffer) {
        resumeBuffer = pdfBuffer;
        console.log(`✅ Tailored PDF generated for ${candidate.name}`);
        uploadTailoredResume(pdfBuffer, candidate.id, job.company).catch(e => console.log("Blob upload error:", e.message));
      }
    }
    if (!resumeBuffer && candidate.resume && candidate.resume.url) {
      const response = await fetch(candidate.resume.url);
      const arrayBuffer = await response.arrayBuffer();
      resumeBuffer = Buffer.from(arrayBuffer);
      resumeFilename = candidate.resume.filename || resumeFilename;
      resumeMimeType = candidate.resume.mimeType || resumeMimeType;
      console.log(`⚠️ Using original resume for ${candidate.name}`);
    }
  } catch(e) {
    console.log(`Resume error ${candidate.name}:`, e.message);
    if (candidate.resume && candidate.resume.url) {
      try {
        const response = await fetch(candidate.resume.url);
        const arrayBuffer = await response.arrayBuffer();
        resumeBuffer = Buffer.from(arrayBuffer);
        resumeFilename = candidate.resume.filename || resumeFilename;
        resumeMimeType = candidate.resume.mimeType || resumeMimeType;
      } catch(e2) {}
    }
  }

  // Build MIME email with attachment
  const boundary = "boundary_" + Date.now();
  let mimeMessage = "";

  if (resumeBuffer) {
    // Multipart email with attachment
    mimeMessage = [
      `From: ${candidate.name} <${candidate.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
      ``,
      `--${boundary}`,
      `Content-Type: ${resumeMimeType}`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${resumeFilename}"`,
      ``,
      resumeBuffer.toString("base64"),
      `--${boundary}--`
    ].join("\r\n");
  } else {
    // Plain text email without attachment
    mimeMessage = [
      `From: ${candidate.name} <${candidate.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body
    ].join("\r\n");
  }

  const raw = Buffer.from(mimeMessage).toString("base64url");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw }
  });
  console.log(`✅ Sent from ${candidate.email} to ${to} ${resumeBuffer ? '(with resume)' : '(no resume)'}`);
}

async function updateSheet(candidate, job, hrEmail, subject, sent, source) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });

    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Sheet1!A:K",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          job.title || "",
          job.company || "",
          job.location || "",
          job.url || "",
          source || "LinkedIn Post",
          hrEmail || "",
          candidate.name || "",
          subject || "",
          sent ? "Yes" : "No",
          new Date().toLocaleDateString("en-IN"),
          "Applied"
        ]]
      }
    });

    console.log(`📊 Sheet updated! ${candidate.name} → ${job.company}`);
  } catch(e) {
    console.log("Sheet update FAILED:", e.message);
  }
}

async function saveToLinkedInBin(post) {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    const posts = Array.isArray(data.record) ? data.record.filter(p => !p.init) : [];
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
    let candidates = await getCandidates();
    if (candidates.length === 0) {
      return res.json({ success: false, error: "No candidates registered yet!" });
    }
    // Filter to specific candidate if requested
    const { candidateId } = req.body;
    if (candidateId && candidateId !== "all") {
      candidates = candidates.filter(c => c.id === candidateId);
      if (candidates.length === 0) {
        return res.json({ success: false, error: "Candidate not found!" });
      }
    }

    // Parse job details from text or image
    let jobDetails = null;
    if (type === "image" && imageBase64) {
      jobDetails = await parseImagePost(imageBase64, groq);
    } else if (text) {
      jobDetails = await parseJobPost(text, groq);
    }

    if (!jobDetails) {
      return res.json({ success: false, error: "Could not extract job details. Please add more details." });
    }

    console.log("Parsed job:", JSON.stringify(jobDetails));

    // Find HR email
    const hrEmail = (email && isRealPersonEmail(email)) ? email :
                    (jobDetails.recruiterEmail && isRealPersonEmail(jobDetails.recruiterEmail)) ? 
                    jobDetails.recruiterEmail : null;

    const job = {
      title: jobDetails.title || "D365 Developer",
      company: jobDetails.company || "Company",
      location: jobDetails.location || "India",
      url: url || "",
      skills: jobDetails.skills || []
    };

    // Save to LinkedIn bin
    await saveToLinkedInBin({
      text: text?.substring(0, 200) || "Image post",
      company: job.company,
      hrEmail,
      url,
      processed: !!hrEmail,
      emailsSent: hrEmail ? candidates.length : 0,
      addedAt: new Date().toISOString()
    });

    if (!hrEmail) {
      return res.json({
        success: false,
        jobDetails,
        error: `Job parsed successfully! Company: ${job.company}, Title: ${job.title}. But no recruiter email found. Please add the recruiter's email (firstname.lastname@company.com format) in the email field!`
      });
    }

    // Send from ALL candidates
    for (const candidate of candidates) {
      try {
        const { subject, body } = await generateEmail(candidate, job, groq, jobDetails.recruiterName);
        let sent = false;
        try {
          await sendGmail(candidate, hrEmail, subject, body, job);
          sent = true;
        } catch(e) {
          console.log(`❌ Gmail ${candidate.name}:`, e.message);
        }
        await updateSheet(candidate, job, hrEmail, subject, sent);
        results.push({ candidate: candidate.name, company: job.company, hrEmail, sent });
        await saveApplication({
          candidateName: candidate.name,
          candidateEmail: candidate.email,
          company: job.company,
          hrEmail,
          subject,
          sent
        });
        // Small delay between candidates - safe for Vercel timeout
        await new Promise(r => setTimeout(r, 3000));
      } catch(e) {
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
    console.error("Fatal:", e);
    res.status(500).json({ success: false, error: e.message });
  }
};
