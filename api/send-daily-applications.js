const { google } = require("googleapis");
const Groq = require("groq-sdk");

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_REFRESH_TOKEN = process.env.SHEET_REFRESH_TOKEN;

// ============================================================
// GET CANDIDATES
// ============================================================
async function getCandidates() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
  });
  const data = await res.json();
  return Array.isArray(data.record) ? data.record.filter(c => !c.init && c.refreshToken) : [];
}

// ============================================================
// GET LINKEDIN POSTS FROM JSONBIN
// ============================================================
async function getLinkedInPosts() {
  try {
    const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;
    if (!LINKEDIN_BIN_ID) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    return Array.isArray(data.record) ? data.record.filter(p => !p.processed) : [];
  } catch(e) {
    return [];
  }
}

// ============================================================
// PARSE LINKEDIN POST WITH GROQ AI
// ============================================================
async function parseLinkedInPost(post, groq) {
  const prompt = `Extract job details from this LinkedIn recruiter post.
Return ONLY valid JSON, no explanation:

Post: "${post.text}"

Return:
{
  "title": "job title",
  "company": "company name",
  "location": "location",
  "recruiterName": "recruiter name if mentioned",
  "recruiterEmail": "email if mentioned or null",
  "skills": "key skills mentioned",
  "experience": "experience required"
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300
  });

  try {
    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) {
    return null;
  }
}

// ============================================================
// SCRAPE JOBS (Sample - real scraping via Python)
// ============================================================
async function scrapeJobs() {
  return [
    { title: "Senior D365 CRM Developer", company: "Capgemini", location: "Hyderabad", url: "https://capgemini.com/careers", source: "LinkedIn", description: "Senior D365 CE developer C#.NET plugins Azure Functions Power Platform Power Automate" },
    { title: "MS Dynamics 365 CE Developer", company: "Infosys", location: "Bangalore", url: "https://infosys.com/careers", source: "Indeed", description: "D365 CRM customization Power Platform plugins workflows JavaScript FetchXML" },
    { title: "D365 CE Technical Consultant", company: "Wipro", location: "Hyderabad", url: "https://wipro.com/careers", source: "LinkedIn", description: "Dynamics 365 CE developer Azure DevOps CI/CD Ribbon Workbench XRM Toolbox" }
  ];
}

// ============================================================
// REAL EMAIL FILTER - Only name@company format
// ============================================================
function isRealPersonEmail(email) {
  if (!email) return false;
  const local = email.split("@")[0].toLowerCase();
  const generic = ["hr", "careers", "recruitment", "jobs", "info", "contact", "admin", "support", "hello", "team", "noreply", "no-reply"];
  if (generic.includes(local)) return false;
  if (local.includes(".")) return true;
  const knownGood = ["talent.acquisition", "india.recruitment", "careers.india", "india.staffing", "talent.india"];
  if (knownGood.some(k => email.toLowerCase().includes(k))) return true;
  return false;
}

async function findHREmail(company) {
  const knownEmails = {
    "capgemini": "careers.india@capgemini.com",
    "infosys": "talent.acquisition@infosys.com",
    "wipro": "india.recruitment@wipro.com",
    "accenture": "india.recruitment@accenture.com",
    "tcs": "talent.acquisition@tcs.com",
    "cognizant": "india.staffing@cognizant.com",
    "tech mahindra": "talent.acquisition@techmahindra.com",
    "genpact": "talent.india@genpact.com",
    "evoke": "talent@evoketechnologies.com",
    "customertimes": "recruiting@customertimes.com",
    "mphasis": "talent.acquisition@mphasis.com",
    "hexaware": "talent@hexaware.com"
  };

  const companyLower = company.toLowerCase();
  for (const [key, email] of Object.entries(knownEmails)) {
    if (companyLower.includes(key) && isRealPersonEmail(email)) return email;
  }

  try {
    const res = await fetch(`https://api.apollo.io/api/v1/mixed_people/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.APOLLO_API_KEY },
      body: JSON.stringify({
        q_organization_name: company,
        person_titles: ["HR Manager", "Recruiter", "Talent Acquisition Manager", "HR Business Partner"],
        per_page: 1
      })
    });
    const data = await res.json();
    const email = data.people?.[0]?.email;
    if (email && isRealPersonEmail(email)) return email;
  } catch(e) {}

  return null;
}

// ============================================================
// GENERATE CONFIDENT + POLITE + ATTRACTIVE EMAIL
// ============================================================
async function generateEmail(candidate, job, groq, isLinkedIn = false, recruiterName = null) {
  
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";
  const linkedInContext = isLinkedIn ? "I came across your LinkedIn post about this opportunity and" : "I";
  
  const prompt = `Write a CONFIDENT, POLITE and ATTRACTIVE job application email.

Candidate Details:
- Name: ${candidate.name}
- Experience: ${candidate.experience} years Microsoft Dynamics 365 CRM Developer
- Role: ${candidate.role}
- Key Skills: C#.NET plugins, Power Platform, Azure Functions, Azure DevOps, FetchXML, JavaScript, Ribbon Workbench

Job Details:
- Position: ${job.title}
- Company: ${job.company}
- Location: ${job.location}
- Requirements: ${job.description}

Instructions:
- Start with: "${greeting},"
- ${linkedInContext} am writing to express strong interest
- Be CONFIDENT (not desperate), POLITE and PROFESSIONAL
- Mention ${candidate.experience} years experience naturally
- Highlight 2-3 most relevant skills matching the job
- Show enthusiasm for the company specifically
- End with clear call to action
- Max 130 words
- Make it ATTRACTIVE and memorable, not generic

Write:
SUBJECT: [compelling subject line mentioning years of experience]

BODY:
[email body]`;

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
    subject: `${candidate.experience}+ Years D365 CRM Expert | Application for ${job.title} - ${candidate.name}`,
    body: `${greeting},\n\nI came across the ${job.title} opportunity at ${job.company} and I'm excited to apply. With ${candidate.experience}+ years of hands-on Microsoft Dynamics 365 CRM development experience, I have delivered enterprise solutions involving C#.NET plugins, Power Platform, Azure Functions, and Azure DevOps CI/CD pipelines.\n\nMy background aligns well with your requirements, and I am confident in adding immediate value to your team at ${job.company}.\n\nI would welcome the opportunity to discuss how my expertise can contribute to your goals. Please find my resume attached.\n\nBest regards,\n${candidate.name}\n📱 ${candidate.phone || ''} | ✉️ ${candidate.email}`
  };
}

// ============================================================
// SEND EMAIL VIA GMAIL API
// ============================================================
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

// ============================================================
// UPDATE GOOGLE SHEET
// ============================================================
async function updateSheet(candidate, job, hrEmail, subject, sent, source) {
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
          job.title,
          job.company,
          job.location,
          job.url || "",
          source || job.source,
          hrEmail,
          candidate.name,
          subject,
          sent ? "Yes" : "No",
          new Date().toLocaleDateString("en-IN"),
          "Applied"
        ]]
      }
    });
    console.log(`📊 Sheet updated: ${candidate.name} → ${job.company}`);
  } catch(e) {
    console.log("Sheet update failed:", e.message);
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async (req, res) => {
  console.log("🚀 D365 Job Hunter Daily Run - " + new Date().toISOString());
  const results = [];
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  try {
    const candidates = await getCandidates();
    console.log(`👥 ${candidates.length} candidates found`);
    if (candidates.length === 0) return res.json({ success: true, message: "No candidates registered" });

    // ---- PROCESS SCRAPED JOBS ----
    const jobs = await scrapeJobs();
    console.log(`🔍 ${jobs.length} scraped jobs`);

    for (const job of jobs) {
      const hrEmail = await findHREmail(job.company);
      if (!hrEmail) { console.log(`⏭ Skip ${job.company} - no real HR email`); continue; }
      console.log(`✅ Real HR email: ${hrEmail}`);

      for (const candidate of candidates) {
        try {
          const { subject, body } = await generateEmail(candidate, job, groq, false, null);
          let sent = false;
          try {
            await sendGmail(candidate, hrEmail, subject, body);
            sent = true;
          } catch(e) {
            console.log(`❌ Gmail error ${candidate.name}:`, e.message);
          }
          await updateSheet(candidate, job, hrEmail, subject, sent, "Scraped");
          results.push({ candidate: candidate.name, company: job.company, hrEmail, sent, source: "Scraped" });
          await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
          console.log(`Error ${candidate.name}:`, e.message);
        }
      }
    }

    // ---- PROCESS LINKEDIN POSTS ----
    const linkedInPosts = await getLinkedInPosts();
    console.log(`📱 ${linkedInPosts.length} LinkedIn posts to process`);

    for (const post of linkedInPosts) {
      try {
        const jobDetails = await parseLinkedInPost(post, groq);
        if (!jobDetails) continue;

        const hrEmail = post.email || jobDetails.recruiterEmail || await findHREmail(jobDetails.company);
        if (!hrEmail || !isRealPersonEmail(hrEmail)) {
          console.log(`⏭ Skip LinkedIn post - no real email`);
          continue;
        }

        const job = {
          title: jobDetails.title,
          company: jobDetails.company,
          location: jobDetails.location || "India",
          url: post.url || "",
          source: "LinkedIn Post",
          description: jobDetails.skills || post.text?.substring(0, 200)
        };

        for (const candidate of candidates) {
          try {
            const { subject, body } = await generateEmail(candidate, job, groq, true, jobDetails.recruiterName);
            let sent = false;
            try {
              await sendGmail(candidate, hrEmail, subject, body);
              sent = true;
            } catch(e) {
              console.log(`❌ Gmail error ${candidate.name}:`, e.message);
            }
            await updateSheet(candidate, job, hrEmail, subject, sent, "LinkedIn Post");
            results.push({ candidate: candidate.name, company: job.company, hrEmail, sent, source: "LinkedIn Post" });
            await new Promise(r => setTimeout(r, 2000));
          } catch(e) {
            console.log(`Error ${candidate.name}:`, e.message);
          }
        }
      } catch(e) {
        console.log("LinkedIn post error:", e.message);
      }
    }

    const sentCount = results.filter(r => r.sent).length;
    console.log(`\n✅ Done! ${sentCount}/${results.length} emails sent`);

    res.json({
      success: true,
      candidates: candidates.length,
      scrapedJobs: jobs.length,
      linkedInPosts: linkedInPosts.length,
      emailsSent: sentCount,
      results
    });

  } catch(e) {
    console.error("Fatal error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
};
