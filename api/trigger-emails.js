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
  
  // Get job-relevant skills
  const jobSkills = Array.isArray(job.skills) ? job.skills : 
    (job.skills || "C#.NET, Power Platform, Azure").split(",").map(s => s.trim());

  const prompt = `Write a professional job application email following this EXACT structure:

1. Subject: [${candidate.experience}+ Years D365 CRM Developer] | [Job Title] Role at [Company]
2. Greeting: ${greeting},
3. One-line intro: who the candidate is (name + experience + role)
4. "Here's what I bring to [company]:" followed by exactly 3 bullet points with relevant skills from: ${jobSkills.join(", ")}
   Format: • [Skill] — [one specific achievement or value]
5. Call to action: "I'd love a quick 15-minute call to explore how I can contribute."
6. Contact block:
   📱 ${candidate.phone || 'Available on request'}
   🔗 ${candidate.linkedin || 'linkedin.com/in/' + candidate.name.toLowerCase().replace(' ', '')}
   ✉️ ${candidate.email}
7. "Best regards," + name

Candidate details:
- Name: ${candidate.name}
- Experience: ${candidate.experience}+ years D365 CRM
- Past clients: MSCI, Walmart Health & Wellness, Unilever, SIS K-12
- Key skills: C#.NET Plugins, Power Platform, Azure Functions, Azure DevOps, JavaScript, FetchXML

Job: ${job.title} at ${job.company} (${job.location})

Write ONLY the email. No explanations. Follow the structure exactly.`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600
  });

  const text = response.choices[0].message.content;
  
  // Extract subject and body
  const lines = text.split("\n");
  let subject = "";
  let bodyLines = [];
  let foundSubject = false;
  
  for (const line of lines) {
    if (line.toLowerCase().startsWith("subject:")) {
      subject = line.replace(/^subject:\s*/i, "").trim();
      foundSubject = true;
    } else if (foundSubject) {
      bodyLines.push(line);
    }
  }

  if (!subject) {
    subject = `${candidate.experience}+ Years D365 CRM Developer | ${job.title} Role at ${job.company}`;
    bodyLines = text.split("\n");
  }

  const body = bodyLines.join("\n").trim();

  return { subject, body };
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
  console.log(`✅ Sent from ${candidate.email} to ${to}`);
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
    console.log(`📊 Sheet: ${candidate.name} → ${job.company}`);
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
    const candidates = await getCandidates();
    if (candidates.length === 0) {
      return res.json({ success: false, error: "No candidates registered yet!" });
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
          await sendGmail(candidate, hrEmail, subject, body);
          sent = true;
        } catch(e) {
          console.log(`❌ Gmail ${candidate.name}:`, e.message);
        }
        await updateSheet(candidate, job, hrEmail, subject, sent);
        results.push({ candidate: candidate.name, company: job.company, hrEmail, sent });
        await new Promise(r => setTimeout(r, 1500));
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
