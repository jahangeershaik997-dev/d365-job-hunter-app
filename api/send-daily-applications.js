const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { alreadySent, markAsSent } = require("../lib/sent-tracker");

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

async function getLinkedInPosts() {
  try {
    const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;
    if (!LINKEDIN_BIN_ID) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    const data = await res.json();
    return Array.isArray(data.record) ? data.record.filter(p => !p.processed && !p.init) : [];
  } catch(e) { return []; }
}

async function scrapeJobs() {
  try {
    const { execSync } = require("child_process");
    const result = execSync(`python3 -c "
from jobspy import scrape_jobs
import json
try:
    jobs = scrape_jobs(
        site_name=['linkedin','indeed'],
        search_term='Microsoft Dynamics 365 CRM Developer',
        location='India',
        results_wanted=20,
        hours_old=24,
        country_indeed='India'
    )
    filtered = []
    skip_words = ['intern','fresher','trainee','junior','graduate','entry']
    for _, job in jobs.iterrows():
        title = str(job.get('title','')).lower()
        if any(x in title for x in skip_words):
            continue
        filtered.append({
            'title': str(job.get('title','')),
            'company': str(job.get('company','')),
            'location': str(job.get('location','')),
            'url': str(job.get('job_url','')),
            'source': str(job.get('site','')),
            'description': str(job.get('description',''))[:400]
        })
    print(json.dumps(filtered[:15]))
except Exception as e:
    print(json.dumps([]))
"`, { timeout: 120000 });
    const jobs = JSON.parse(result.toString().trim());
    if (jobs.length > 0) {
      console.log(`✅ Scraped ${jobs.length} real jobs`);
      return jobs;
    }
  } catch(e) {
    console.log("Scrape failed, using fallback job list:", e.message);
  }
  return [
    { title: "Senior D365 CRM Developer", company: "Capgemini", location: "Hyderabad", url: "https://capgemini.com/careers", source: "LinkedIn", description: "Senior D365 CE developer C#.NET plugins Azure Functions Power Platform" },
    { title: "MS Dynamics 365 CE Developer", company: "Infosys", location: "Bangalore", url: "https://infosys.com/careers", source: "Indeed", description: "D365 CRM customization Power Platform plugins workflows" },
    { title: "D365 CE Technical Consultant", company: "Wipro", location: "Hyderabad", url: "https://wipro.com/careers", source: "LinkedIn", description: "Dynamics 365 CE developer Azure DevOps CI/CD" }
  ];
}

// STRICT - Only firstname.lastname@company.com format
function isRealPersonEmail(email) {
  if (!email) return false;
  const local = email.split("@")[0].toLowerCase();
  
  const blacklist = [
    "hr", "careers", "career", "recruitment", "recruit", "jobs", "job",
    "info", "contact", "admin", "support", "hello", "team", "talent",
    "india", "noreply", "no-reply", "hiring", "apply", "applications",
    "application", "staffing", "staff", "people", "humanresources",
    "acquisition", "resumes", "resume", "work", "opportunity", "connect",
    "recruiting", "joinus", "getintouch", "enquiry", "enquiries"
  ];
  
  const parts = local.split(".");
  for (const part of parts) {
    if (blacklist.includes(part)) return false;
  }
  
  // Must have a dot = firstname.lastname
  if (!local.includes(".")) return false;
  
  // Each part must be a real name (letters only, min 2 chars)
  for (const part of parts) {
    if (part.length < 2) return false;
    if (!/^[a-z]+$/.test(part)) return false;
  }
  
  return true;
}

async function findHREmail(company) {
  try {
    const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.APOLLO_API_KEY
      },
      body: JSON.stringify({
        q_organization_name: company,
        person_titles: ["Technical Recruiter","IT Recruiter","HR Manager","Talent Acquisition","Recruitment Manager"],
        per_page: 5
      })
    });
    const data = await res.json();
    for (const person of (data.people || [])) {
      if (person.email && isRealPersonEmail(person.email)) {
        console.log(`✅ Apollo: ${person.first_name} - ${person.email}`);
        return { email: person.email, name: person.first_name };
      }
    }
  } catch(e) {
    console.log("Apollo error:", e.message);
  }
  return null;
}

async function generateEmail(candidate, job, groq, isLinkedIn = false, recruiterName = null) {
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";
  const linkedInContext = isLinkedIn ? "I came across your LinkedIn post and" : "I";

  const prompt = `Write a CONFIDENT, POLITE and ATTRACTIVE job application email.

Candidate: ${candidate.name}
Experience: ${candidate.experience} years Microsoft Dynamics 365 CRM Developer
Role: ${candidate.role}
Key Skills: C#.NET plugins, Power Platform, Azure Functions, Azure DevOps, JavaScript, FetchXML

Job: ${job.title} at ${job.company}
Location: ${job.location}
Requirements: ${job.description}

Instructions:
- Start with "${greeting},"
- ${linkedInContext} am writing to express strong interest
- Be CONFIDENT, POLITE and PROFESSIONAL (not desperate)
- Mention ${candidate.experience} years experience naturally
- Highlight 2-3 most relevant skills
- Show genuine enthusiasm for ${job.company}
- End with clear call to action
- Max 130 words
- Make it ATTRACTIVE and memorable

Write:
SUBJECT: [compelling subject line]

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
    subject: `${candidate.experience}+ Years D365 CRM Expert | ${job.title} - ${candidate.name}`,
    body: `${greeting},\n\nI came across the ${job.title} opportunity at ${job.company} and I'm excited to apply. With ${candidate.experience}+ years of hands-on Microsoft Dynamics 365 CRM development experience, I have delivered enterprise solutions involving C#.NET plugins, Power Platform, Azure Functions, and Azure DevOps CI/CD.\n\nMy background aligns well with your requirements and I am confident in adding immediate value to your team.\n\nI would welcome the opportunity to discuss further. Please find my resume attached.\n\nBest regards,\n${candidate.name}\n✉️ ${candidate.email}`
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
          source || job.source || "",
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

async function parseLinkedInPost(post, groq) {
  const prompt = `Extract job details from this LinkedIn recruiter post. Return ONLY valid JSON:

Post: "${post.text}"

{
  "title": "job title",
  "company": "company name",
  "location": "location or India",
  "recruiterName": "first name only if mentioned",
  "skills": "key skills mentioned"
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 200
  });

  try {
    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  console.log("🚀 D365 Job Hunter - " + new Date().toISOString());
  const results = [];
  const skipped = [];
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  try {
    const candidates = await getCandidates();
    console.log(`👥 ${candidates.length} candidates`);
    if (candidates.length === 0) return res.json({ success: true, message: "No candidates" });

    // SCRAPED JOBS
    const jobs = await scrapeJobs();
    for (const job of jobs) {
      const hr = await findHREmail(job.company);
      if (!hr) {
        console.log(`⏭ Skip ${job.company} - no real person email found`);
        skipped.push(job.company);
        continue;
      }
      const hrEmail = hr.email;

      for (const candidate of candidates) {
        try {
          const isDuplicate = await alreadySent(candidate.email, hrEmail);
          if (isDuplicate) {
            console.log(`⏭ Skip duplicate: ${candidate.name} → ${hrEmail}`);
            continue;
          }

          const { subject, body } = await generateEmail(candidate, job, groq, false, hr.name);
          let sent = false;
          try {
            await sendGmail(candidate, hrEmail, subject, body);
            sent = true;
            if (sent) await markAsSent(candidate.email, hrEmail);
          } catch(e) {
            console.log(`❌ ${candidate.name}:`, e.message);
          }
          await updateSheet(candidate, job, hrEmail, subject, sent, "Scraped");
          results.push({ candidate: candidate.name, company: job.company, hrEmail, sent });
          await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
          console.log(`Error:`, e.message);
        }
      }
    }

    // LINKEDIN POSTS
    const posts = await getLinkedInPosts();
    for (const post of posts) {
      try {
        const details = await parseLinkedInPost(post, groq);
        if (!details) continue;

        let hrEmail = null;
        let apolloName = null;
        if (post.email && isRealPersonEmail(post.email)) {
          hrEmail = post.email;
        } else {
          const hr = await findHREmail(details.company);
          if (hr) {
            hrEmail = hr.email;
            apolloName = hr.name;
          }
        }
        if (!hrEmail) {
          console.log(`⏭ Skip LinkedIn post - no real person email`);
          continue;
        }

        const job = {
          title: details.title,
          company: details.company,
          location: details.location || "India",
          url: post.url || "",
          source: "LinkedIn Post",
          description: details.skills || ""
        };

        for (const candidate of candidates) {
          try {
            const isDuplicate = await alreadySent(candidate.email, hrEmail);
            if (isDuplicate) {
              console.log(`⏭ Skip duplicate: ${candidate.name} → ${hrEmail}`);
              continue;
            }

            const { subject, body } = await generateEmail(candidate, job, groq, true, details.recruiterName || apolloName);
            let sent = false;
            try {
              await sendGmail(candidate, hrEmail, subject, body);
              sent = true;
              if (sent) await markAsSent(candidate.email, hrEmail);
            } catch(e) {
              console.log(`❌ ${candidate.name}:`, e.message);
            }
            await updateSheet(candidate, job, hrEmail, subject, sent, "LinkedIn Post");
            results.push({ candidate: candidate.name, company: job.company, hrEmail, sent, source: "LinkedIn Post" });
            await new Promise(r => setTimeout(r, 2000));
          } catch(e) {
            console.log(`Error:`, e.message);
          }
        }
      } catch(e) {
        console.log("Post error:", e.message);
      }
    }

    res.json({
      success: true,
      candidates: candidates.length,
      emailsSent: results.filter(r => r.sent).length,
      skippedCompanies: skipped,
      results
    });

  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
};
