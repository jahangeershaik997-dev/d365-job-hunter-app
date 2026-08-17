const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { tailorResumeText, generatePDF, uploadTailoredResume } = require("./tailor-resume");
const { saveApplication } = require("../lib/history");
const { alreadySent, markAsSent } = require("../lib/sent-tracker");

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

  // Only block clearly generic department emails
  const blacklist = [
    "hr", "careers", "career", "recruitment", "jobs", "job",
    "info", "contact", "admin", "support", "hello", "team",
    "noreply", "no-reply", "hiring", "apply", "staffing",
    "humanresources", "enquiry", "enquiries", "recruiting",
    "joinus", "getintouch", "talent", "resumes", "resume"
  ];

  // If has dot - firstname.lastname format
  if (local.includes(".")) {
    const parts = local.split(".");
    // Reject if the first part alone is a blacklisted department word
    // e.g. hr.manager = reject, kumar.unnati = allow
    if (blacklist.includes(parts[0])) return false;
    return true;
  }

  // Single word - check blacklist
  if (blacklist.includes(local)) return false;

  // Single word not blacklisted, min 3 chars
  if (local.length >= 3 && /^[a-z]+$/.test(local)) return true;

  return false;
}

async function parseJobPost(text, groq) {
  const prompt = `Extract job details from this recruiter post.
Return ONLY valid JSON with no explanation.

POST TEXT:
"${text.substring(0, 800)}"

IMPORTANT EXTRACTION RULES:
- company: Look for company name mentioned anywhere in the post
  Check for: "at [Company]", "for [Company]", company signature,
  email domain (e.g. rajkiran@burgeonits.com = Burgeon IT Services),
  website URL (www.burgeonits.com = Burgeon IT Services)
  NEVER return "Company" as the value - always find the real name
- title: exact job title from the post
- location: city or country mentioned
- recruiterName: first name of recruiter if mentioned
- recruiterEmail: email address if mentioned in post
- skills: technical skills listed

Return:
{
  "title": "exact job title",
  "company": "real company name - never use generic Company",
  "location": "city/country or India",
  "recruiterName": "first name only or null",
  "recruiterEmail": "email@domain.com or null",
  "skills": ["skill1", "skill2", "skill3"]
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300
  });

  try {
    const t = response.choices[0].message.content;
    const json = t.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const jobDetails = JSON.parse(json);

    // Auto-detect email from post text if Groq missed it
    if (!jobDetails.recruiterEmail) {
      const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
      const emailsFound = text.match(emailRegex);
      if (emailsFound) {
        for (const foundEmail of emailsFound) {
          if (isRealPersonEmail(foundEmail)) {
            jobDetails.recruiterEmail = foundEmail;
            console.log("Auto-detected email:", foundEmail);
            break;
          }
        }
      }
    }

    // Also auto-detect company from email domain if missing
    if (!jobDetails.company || jobDetails.company === "Company") {
      if (jobDetails.recruiterEmail) {
        const domain = jobDetails.recruiterEmail.split("@")[1];
        const companyFromDomain = domain
          .replace(/\.(com|in|io|co|net|org)$/, "")
          .replace(/its$/, " IT Services")
          .replace(/tech$/, " Technologies")
          .replace(/-/g, " ");
        jobDetails.company = companyFromDomain
          .split(" ")
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        console.log("Company from domain:", jobDetails.company);
      }
    }

    return jobDetails;
  } catch(e) { return null; }
}

async function parseImagePost(imageBase64, groq) {
  try {
    // NOTE: llama-3.3-70b-versatile is a text-only Groq model. If it doesn't
    // accept image_url content at all, this will keep failing with the same
    // "string did not match the expected pattern" error - swap in whichever
    // vision-capable model is current in your Groq console (their vision
    // model names/availability have moved around, so no name is hardcoded
    // here without being able to verify it against Groq's live catalog).
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imageBase64,
              detail: "high"
            }
          },
          {
            type: "text",
            text: `Extract job details from this image of a job posting.
Look carefully at all text in the image.
Return ONLY valid JSON:
{
  "title": "job title from image",
  "company": "company name from image - check email domains and logos",
  "location": "location from image",
  "recruiterName": "recruiter first name if visible",
  "recruiterEmail": "email address if visible in image",
  "skills": ["skill1", "skill2", "skill3"]
}`
          }
        ]
      }],
      max_tokens: 500
    });

    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const parsed = JSON.parse(json);
      console.log("Image parsed:", JSON.stringify(parsed));
      return parsed;
    }
    return null;
  } catch(e) {
    console.log("Image parse error:", e.message);
    return null;
  }
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
    let hrEmail = null;
    let recruiterName = jobDetails.recruiterName || null;

    // Step 1: Use provided email
    if (email && isRealPersonEmail(email)) {
      hrEmail = email;
      console.log(`✅ Using provided email: ${email}`);
    }

    // Step 2: Use email from post text
    if (!hrEmail && jobDetails.recruiterEmail &&
        isRealPersonEmail(jobDetails.recruiterEmail)) {
      hrEmail = jobDetails.recruiterEmail;
      console.log(`✅ Using email from post: ${hrEmail}`);
    }

    // Step 3: Auto-find via Apollo if no email found
    if (!hrEmail && jobDetails.company) {
      console.log(`🔍 Apollo searching HR at: ${jobDetails.company}`);
      try {
        const apolloRes = await fetch(
          "https://api.apollo.io/api/v1/mixed_people/search",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Api-Key": process.env.APOLLO_API_KEY
            },
            body: JSON.stringify({
              q_organization_name: jobDetails.company,
              person_titles: [
                "Technical Recruiter",
                "IT Recruiter",
                "HR Manager",
                "Talent Acquisition Manager",
                "Recruitment Manager",
                "Hiring Manager"
              ],
              per_page: 5
            })
          }
        );
        const apolloData = await apolloRes.json();
        for (const person of (apolloData.people || [])) {
          if (person.email && isRealPersonEmail(person.email)) {
            hrEmail = person.email;
            recruiterName = person.first_name || null;
            console.log(`✅ Apollo found: ${recruiterName} - ${hrEmail}`);
            break;
          }
        }
      } catch(e) {
        console.log("Apollo error:", e.message);
      }
    }

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
        error: `Job parsed! Company: ${jobDetails.company}, Title: ${jobDetails.title}. Apollo could not find HR email. Please add recruiter email manually (firstname.lastname@company.com)`
      });
    }

    // Send from ALL candidates
    for (const candidate of candidates) {
      try {
        // CHECK: Already sent to this HR from this candidate?
        const isDuplicate = await alreadySent(candidate.email, hrEmail);
        if (isDuplicate) {
          console.log(`⏭ Skip duplicate: ${candidate.name} → ${hrEmail}`);
          results.push({
            candidate: candidate.name,
            company: job.company,
            hrEmail,
            sent: false,
            reason: "Already sent"
          });
          continue;
        }

        const { subject, body } = await generateEmail(candidate, job, groq, recruiterName);
        let sent = false;
        try {
          await sendGmail(candidate, hrEmail, subject, body, job);
          sent = true;
          // Mark as sent to prevent duplicates
          await markAsSent(candidate.email, hrEmail);
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
