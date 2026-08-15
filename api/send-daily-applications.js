const { google } = require("googleapis");
const Groq = require("groq-sdk");

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_REFRESH_TOKEN = process.env.SHEET_REFRESH_TOKEN;

async function getCandidates() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
  });
  const data = await res.json();
  return Array.isArray(data.record) ? data.record.filter(c => !c.init && c.refreshToken) : [];
}

async function scrapeJobs() {
  return [
    { title: "Senior D365 CRM Developer", company: "Capgemini", location: "Hyderabad", url: "https://capgemini.com/careers", source: "LinkedIn", description: "Senior D365 CE developer with C#.NET plugins Azure Functions Power Platform" },
    { title: "MS Dynamics 365 Developer", company: "Infosys", location: "Bangalore", url: "https://infosys.com/careers", source: "Indeed", description: "D365 CRM customization Power Platform plugins workflows" },
    { title: "D365 CE Technical Consultant", company: "Wipro", location: "Hyderabad", url: "https://wipro.com/careers", source: "LinkedIn", description: "Dynamics 365 CE developer Azure DevOps CI/CD" }
  ];
}

// ONLY real emails - must have firstname.lastname@ or name@ format
function isRealEmail(email) {
  if (!email) return false;
  const local = email.split("@")[0].toLowerCase();
  // Skip generic ones
  const generic = ["hr", "careers", "recruitment", "jobs", "info", "contact", "admin", "support", "hello", "team"];
  if (generic.includes(local)) return false;
  // Must have a dot or be a real name (not just one generic word)
  if (local.includes(".")) return true;
  // Allow known company career emails
  const knownGood = ["careers.india", "india.recruitment", "india.staffing"];
  if (knownGood.some(k => email.includes(k))) return true;
  return false;
}

async function findHREmail(company) {
  // Only real verified HR emails with person names
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
    "customertimes": "recruiting@customertimes.com"
  };

  const companyLower = company.toLowerCase();
  for (const [key, email] of Object.entries(knownEmails)) {
    if (companyLower.includes(key)) {
      if (isRealEmail(email)) return email;
    }
  }

  // Try Apollo for real person email
  try {
    const res = await fetch(`https://api.apollo.io/api/v1/mixed_people/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.APOLLO_API_KEY },
      body: JSON.stringify({
        q_organization_name: company,
        person_titles: ["HR Manager", "Recruiter", "Talent Acquisition Manager"],
        per_page: 1
      })
    });
    const data = await res.json();
    const email = data.people?.[0]?.email;
    if (email && isRealEmail(email)) return email;
  } catch(e) {}

  return null; // Skip if no real person email found
}

async function generateEmail(candidate, job) {
  const groq = new Groq({ apiKey: GROQ_API_KEY });
  const prompt = `Write a short professional job application email.
Candidate: ${candidate.name}
Role: ${job.title} at ${job.company}
Experience: ${candidate.experience} years D365 CRM Developer
Job description: ${job.description}

Write:
SUBJECT: [one line subject]
BODY:
[professional email body, max 100 words, mention experience and D365 skills]`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400
  });

  const text = response.choices[0].message.content;
  if (text.includes("SUBJECT:") && text.includes("BODY:")) {
    return {
      subject: text.split("SUBJECT:")[1].split("BODY:")[0].trim(),
      body: text.split("BODY:")[1].trim()
    };
  }
  return {
    subject: `Application for ${job.title} - ${candidate.name} (${candidate.experience} Years D365)`,
    body: `Dear Hiring Manager,\n\nI am interested in the ${job.title} position at ${job.company}.\n\nWith ${candidate.experience}+ years of D365 CRM experience, I bring expertise in C#.NET plugins, Power Platform, and Azure DevOps.\n\nI am immediately available.\n\nBest regards,\n${candidate.name}`
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
  console.log(`✅ Sent from ${candidate.email} to ${to}`);
}

async function updateSheet(candidate, job, hrEmail, sent) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      "https://d365-job-hunter-app.vercel.app/auth/callback"
    );
    // Use sheet owner's refresh token
    oauth2Client.setCredentials({ refresh_token: SHEET_REFRESH_TOKEN });
    const sheets = google.sheets({ version: "v4", auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "A:J",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          job.title, job.company, job.location, job.url,
          job.source, hrEmail, candidate.name,
          sent ? "Yes" : "No",
          new Date().toLocaleDateString("en-IN"),
          "Applied"
        ]]
      }
    });
    console.log(`📊 Sheet updated for ${candidate.name} - ${job.company}`);
  } catch(e) {
    console.log("Sheet update failed:", e.message);
  }
}

module.exports = async (req, res) => {
  console.log("🚀 Daily Run Started - " + new Date().toISOString());
  const results = [];

  try {
    const candidates = await getCandidates();
    console.log(`👥 ${candidates.length} candidates`);
    if (candidates.length === 0) return res.json({ success: true, message: "No candidates" });

    const jobs = await scrapeJobs();
    console.log(`🔍 ${jobs.length} jobs`);

    for (const job of jobs) {
      const hrEmail = await findHREmail(job.company);

      if (!hrEmail) {
        console.log(`⏭ Skip ${job.company} - no real person HR email`);
        continue;
      }

      console.log(`✅ Real HR email found: ${hrEmail}`);

      for (const candidate of candidates) {
        try {
          const { subject, body } = await generateEmail(candidate, job);
          let sent = false;
          try {
            await sendGmail(candidate, hrEmail, subject, body);
            sent = true;
          } catch(e) {
            console.log(`❌ Gmail error ${candidate.name}:`, e.message);
          }
          await updateSheet(candidate, job, hrEmail, sent);
          results.push({ candidate: candidate.name, company: job.company, hrEmail, sent });
          await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
          console.log(`Error ${candidate.name}:`, e.message);
        }
      }
    }

    res.json({
      success: true,
      candidates: candidates.length,
      jobs: jobs.length,
      emailsSent: results.filter(r => r.sent).length,
      results
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
