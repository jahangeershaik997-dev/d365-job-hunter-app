/**
 * D365 Job Hunter - Daily Application Dispatch Engine
 * 
 * Discovers real D365 jobs via lib/job-sources.js, searches verified recruiter
 * contacts, generates tailored AI application pitches, and dispatches via candidates'
 * authenticated Gmail accounts.
 */

try {
  if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
  }
} catch (e) {}

const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { discoverJobs } = require("../lib/job-sources");
const { alreadySent, markAsSent } = require("../lib/sent-tracker");
const { saveApplication } = require("../lib/history");
const { tailorResumeText, generatePDF, uploadTailoredResume } = require("./tailor-resume");

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || "6a7fe014f5f4af5e29189def";
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY || "$2a$10$mOTOfSBdMCPsMoeb7FIaVubVgsRJqsgyheEbJc2nZ6aZ5p3cKzVJa";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const LINKEDIN_BIN_ID = process.env.LINKEDIN_BIN_ID;

/**
 * Loads registered candidates with valid OAuth credentials
 */
async function getCandidates() {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.log(
        `Candidates JSONBin error: HTTP ${res.status} ${res.statusText} ${errorText.substring(0, 300)}`
      );
      return [];
    }

    const data = await res.json();
    return Array.isArray(data.record)
      ? data.record.filter(c => !c.init && c.email && c.refreshToken)
      : [];
  } catch (e) {
    console.log("Candidates fetch error:", e.message);
    return [];
  }
}

/**
 * Loads queued/unprocessed LinkedIn posts
 */
async function getLinkedInPosts() {
  try {
    if (!LINKEDIN_BIN_ID) return [];
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.record) ? data.record.filter(p => !p.processed && !p.init) : [];
  } catch (e) {
    return [];
  }
}

/**
 * Marks a LinkedIn post as processed
 */
async function markPostProcessed(post) {
  try {
    if (!LINKEDIN_BIN_ID) return;
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, {
      headers: { "X-Master-Key": JSONBIN_MASTER_KEY }
    });
    if (!res.ok) return;
    const data = await res.json();
    const posts = Array.isArray(data.record) ? data.record : [];
    const updated = posts.map(p => p.addedAt === post.addedAt ? { ...p, processed: true } : p);
    await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_MASTER_KEY },
      body: JSON.stringify(updated)
    });
  } catch (e) {
    console.log("Mark post processed error:", e.message);
  }
}

/**
 * Validates whether an email belongs to a real person / verified recruiter
 * and is not a generic department/service mailbox.
 */
function isRealPersonEmail(email) {
  if (!email || typeof email !== "string") return false;
  const cleaned = email.trim().toLowerCase();
  if (!cleaned.includes("@")) return false;
  const [local, domain] = cleaned.split("@");
  if (!local || !domain || !domain.includes(".")) return false;

  const blacklist = [
    "hr", "careers", "career", "recruitment", "recruit", "jobs", "job",
    "info", "contact", "admin", "support", "hello", "team", "talent",
    "india", "noreply", "no-reply", "hiring", "apply", "applications",
    "application", "staffing", "staff", "people", "humanresources",
    "acquisition", "resumes", "resume", "work", "opportunity", "connect",
    "recruiting", "joinus", "getintouch", "enquiry", "enquiries", "askhr"
  ];

  if (local.includes(".")) {
    const parts = local.split(".");
    if (blacklist.includes(parts[0])) return false;
    return parts.every(p => p.length >= 2 && /^[a-z]+$/.test(p));
  }

  if (blacklist.includes(local)) return false;
  if (local.length >= 3 && /^[a-z]+$/.test(local)) return true;

  return false;
}

const recruiterContactCache = new Map();

/**
 * Searches for legitimate recruiter / talent acquisition email
 * Never invents or guesses generic email addresses.
 */
async function findRecruiterContact(job) {
  const companyKey = (job.company || "").trim().toLowerCase();

  if (companyKey && recruiterContactCache.has(companyKey)) {
    const cached = recruiterContactCache.get(companyKey);

    if (cached === null) {
      return null;
    }

    return cached;
  }

  // 1. Check description text for an explicit recruiter email
  if (job.description) {
    const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
    const matches = job.description.match(emailRegex);
    if (matches) {
      for (const email of matches) {
        if (isRealPersonEmail(email)) {
          console.log(`✅ Extracted verified recruiter email from job text: ${email}`);
          const contact = { email, name: null, source: "Job Listing" };
          if (companyKey) {
            recruiterContactCache.set(companyKey, contact);
          }
          return contact;
        }
      }
    }
  }

  // 2. Query Apollo API if configured with key
  const apolloKey = process.env.APOLLO_API_KEY;
  if (apolloKey && job.company && job.company.toLowerCase() !== "confidential") {
    try {
      console.log(`🔍 Apollo search recruiter for: ${job.company}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apolloKey
        },
        body: JSON.stringify({
          q_organization_name: job.company,
          person_titles: [
            "Technical Recruiter",
            "IT Recruiter",
            "Talent Acquisition Specialist",
            "Talent Acquisition Lead",
            "Recruitment Lead",
            "HR Manager",
            "Hiring Manager"
          ],
          per_page: 5
        })
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        console.log(
          `Apollo HTTP error for ${job.company}: ${res.status} ${res.statusText} ${errorText.substring(0, 300)}`
        );
      } else {
        const data = await res.json();
        const people = data.people || [];

        console.log(
          `Apollo result for ${job.company}: ${people.length} people returned`
        );

        for (const person of people) {
          console.log(
            `Apollo person: ${person.first_name || ""} ${person.last_name || ""} | email=${person.email ? "YES" : "NO"}`
          );

          if (person.email && isRealPersonEmail(person.email)) {
            console.log(
              `Apollo accepted contact: ${person.first_name || ""} (${person.email}) at ${job.company}`
            );

            const contact = {
              email: person.email,
              name: person.first_name || null,
              source: "Apollo"
            };

            recruiterContactCache.set(companyKey, contact);
            return contact;
          }
        }
      }
    } catch (e) {
      console.log(`Apollo search error for ${job.company}:`, e.message);
    }
  }

  if (companyKey) {
    recruiterContactCache.set(companyKey, null);
  }

  return null;
}

/**
 * Generates an individualized D365 application pitch with Groq
 */
async function generateEmail(candidate, job, groq, recruiterName = null, isLinkedIn = false) {
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";
  const introContext = isLinkedIn ? "I came across your LinkedIn opportunity and" : "I am reaching out regarding the opportunity and";

  const prompt = `Write a HIGHLY PROFESSIONAL, COMPELLING, and CONFIDENT job application email for a Dynamics 365 role.

CANDIDATE PROFILE:
Name: ${candidate.name}
Experience: ${candidate.experience || "5+"} years Microsoft Dynamics 365 CRM
Role: ${candidate.role || "Dynamics 365 Developer"}
Key Skills: ${Array.isArray(candidate.skills) ? candidate.skills.join(", ") : (candidate.skills || "D365 CRM, C#.NET plugins, Power Platform, Azure Functions, Dataverse")}
Clients/Projects: ${candidate.clients || "Enterprise CRM solutions"}
Certifications: ${candidate.certifications || ""}
Summary: ${candidate.summary || ""}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${(job.description || "").substring(0, 400)}

INSTRUCTIONS:
- Start with "${greeting},"
- ${introContext} am writing to express my strong interest in the ${job.title} position at ${job.company}
- Clearly highlight ${candidate.experience} years of hands-on expertise in Microsoft Dynamics 365 CRM and Power Platform
- Highlight 2-3 specific technical strengths matching this job (e.g., C#.NET plugins, Dataverse, Azure Functions, CI/CD)
- Maintain a polite, confident, senior tone (never desperate)
- Conclude with a clear, professional call to action
- Maximum 140 words
- Return format:
SUBJECT: [Compelling Subject Line]

BODY:
[Email Body]`;

  try {
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

    if (subject && bodyLines.length > 0) {
      return { subject, body: bodyLines.join("\n").trim() };
    }
  } catch (err) {
    console.log("Groq email generation error:", err.message);
  }

  return {
    subject: `${candidate.experience || "5"}+ Years D365 CRM Expert | ${job.title} Application - ${candidate.name}`,
    body: `${greeting},\n\nI am writing to express my strong interest in the ${job.title} position at ${job.company}. With ${candidate.experience || "5"}+ years of specialized experience in Microsoft Dynamics 365 CRM and Power Platform development, I have engineered enterprise solutions utilizing C#.NET plugins, Dataverse, Azure Functions, and automated workflows.\n\nMy technical foundation aligns seamlessly with your requirements and I am confident in delivering immediate value to your engineering team.\n\nI would welcome the opportunity to discuss how my background fits your upcoming goals. Please find my resume attached.\n\nBest regards,\n${candidate.name}\n✉️ ${candidate.email}`
  };
}

/**
 * Dispatches email via Gmail API with resume attachment support
 */
async function sendGmail(candidate, to, subject, body, job) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://d365-job-hunter-app.vercel.app/auth/callback"
  );
  oauth2Client.setCredentials({ refresh_token: candidate.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  let resumeBuffer = null;
  let resumeFilename = `${candidate.name.replace(/\s+/g, "_")}_Resume.pdf`;
  let resumeMimeType = "application/pdf";

  // Attempt tailored PDF generation or fetch original resume
  try {
    if (job && job.company) {
      const tailoredData = await tailorResumeText(candidate, job).catch(() => null);
      if (tailoredData) {
        const pdfBuffer = await generatePDF(tailoredData, candidate, job).catch(() => null);
        if (pdfBuffer) {
          resumeBuffer = pdfBuffer;
          resumeFilename = `${candidate.name.replace(/\s+/g, "_")}_${job.company.replace(/\s+/g, "_")}_Resume.pdf`;
          uploadTailoredResume(pdfBuffer, candidate.id, job.company).catch(e => console.log("Tailored upload error:", e.message));
        }
      }
    }
    if (!resumeBuffer && candidate.resume && candidate.resume.url) {
      const res = await fetch(candidate.resume.url);
      const arr = await res.arrayBuffer();
      resumeBuffer = Buffer.from(arr);
      resumeFilename = candidate.resume.filename || resumeFilename;
      resumeMimeType = candidate.resume.mimeType || resumeMimeType;
    }
  } catch (e) {
    console.log(`Resume attach error for ${candidate.name}:`, e.message);
  }

  const boundary = "boundary_" + Date.now();
  let mimeMessage = "";

  if (resumeBuffer) {
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
  console.log(`✅ Sent from ${candidate.email} to ${to} ${resumeBuffer ? "(with PDF resume)" : ""}`);
}

/**
 * Appends application telemetry to Google Sheets
 */
async function updateSheet(candidate, job, hrEmail, subject, sent, source) {
  try {
    const rawSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!rawSa || !SHEET_ID) return;

    const serviceAccount = JSON.parse(rawSa);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:K",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          job.title || "",
          job.company || "",
          job.location || "",
          job.url || "",
          source || job.source || "Discovered",
          hrEmail || "",
          candidate.name || "",
          subject || "",
          sent ? "Yes" : "No",
          new Date().toLocaleDateString("en-IN"),
          sent ? "Applied" : "Failed"
        ]]
      }
    });
    console.log(`📊 Google Sheets telemetry logged: ${candidate.name} → ${job.company}`);
  } catch (e) {
    console.log("Sheet update failed:", e.message);
  }
}

/**
 * Parses raw LinkedIn post via Groq
 */
async function parseLinkedInPost(post, groq) {
  const prompt = `Extract job details from this LinkedIn recruiter post. Return ONLY valid JSON:

Post: "${post.text}"

{
  "title": "exact job title",
  "company": "company name",
  "location": "location or India",
  "recruiterName": "first name only if mentioned",
  "skills": "key skills mentioned"
}`;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 250
    });
    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Checks candidate location alignment if candidate specified preferred location
 */
function candidateMatchesJob(candidate, job) {
  if (!candidate) return false;
  if (!candidate.location && !candidate.preferredLocation) {
    return true; // No candidate location constraint, open to all
  }
  const pref = (candidate.location || candidate.preferredLocation || "").toLowerCase();
  const jobLoc = (job.location || "").toLowerCase();
  if (pref.includes("remote") || jobLoc.includes("remote") || jobLoc.includes("india")) {
    return true;
  }
  return jobLoc.includes(pref);
}

/**
 * Main Controller Handler for Job Discovery and Outbound Application Automation
 */
module.exports = async (req, res) => {
  console.log("🚀 D365 Job Hunter Run: " + new Date().toISOString());

  const results = [];
  const errors = [];
  let candidateMatches = 0;
  let noContact = 0;
  let readyToApply = 0;
  let emailsSent = 0;
  let emailsFailed = 0;

  const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

  try {
    // 1. Load Candidates
    const candidates = await getCandidates();
    console.log(`👥 Loaded ${candidates.length} active registered candidates`);

    if (candidates.length === 0) {
      return res.json({
        success: true,
        candidates: 0,
        jobsSearched: 0,
        jobsFound: 0,
        d365Matches: 0,
        duplicateJobs: 0,
        candidateMatches: 0,
        noContact: 0,
        readyToApply: 0,
        emailsSent: 0,
        emailsFailed: 0,
        sourceStats: {},
        errors: ["No active candidates with valid OAuth credentials found."],
        results: []
      });
    }

    // 2. Discover Real D365 Jobs
    console.log("🔎 Running D365 Job Discovery...");
    const discovery = await discoverJobs();

    if (discovery.errors && discovery.errors.length > 0) {
      errors.push(...discovery.errors);
    }

    const jobs = discovery.jobs || [];
    console.log(`📋 Discovered ${jobs.length} ranked D365 jobs`);

    // 3. Process Discovered Jobs
    for (const job of jobs) {
      // Find legitimate recruiter contact
      const contact = await findRecruiterContact(job);
      if (!contact || !contact.email) {
        noContact++;
        console.log(`⏭ No verified contact found for: ${job.company} (${job.title})`);
        continue;
      }

      const hrEmail = contact.email;
      const recruiterName = contact.name;

      for (const candidate of candidates) {
        if (!candidateMatchesJob(candidate, job)) {
          continue;
        }

        candidateMatches++;

        // Duplicate Check in Upstash Redis
        const isDuplicate = await alreadySent(candidate.email, hrEmail, job.title);
        if (isDuplicate) {
          console.log(`⏭ Duplicate skipped: ${candidate.name} → ${hrEmail} for "${job.title}"`);
          continue;
        }

        readyToApply++;

        try {
          console.log(`✉️ Generating D365 pitch: ${candidate.name} → ${job.company} (${hrEmail})`);
          const { subject, body } = await generateEmail(candidate, job, groq, recruiterName, false);

          let sent = false;
          let failureReason = null;
          try {
            await sendGmail(candidate, hrEmail, subject, body, job);
            sent = true;
            emailsSent++;
            await markAsSent(candidate.email, hrEmail, job.title);
          } catch (sendErr) {
            emailsFailed++;
            failureReason = sendErr.message;
            console.log(`❌ Gmail send failed for ${candidate.name}:`, sendErr.message);
          }

          await updateSheet(candidate, job, hrEmail, subject, sent, job.source || "Adzuna");
          await saveApplication({
            candidateName: candidate.name,
            candidateEmail: candidate.email,
            company: job.company,
            hrEmail,
            subject,
            sent
          });

          results.push({
            candidate: candidate.name,
            company: job.company,
            jobTitle: job.title,
            hrEmail,
            sent,
            source: job.source || "Adzuna",
            reason: failureReason
          });

          // Pacing delay between email dispatches
          await new Promise(r => setTimeout(r, 2000));
        } catch (jobErr) {
          console.log(`Candidate job dispatch error (${candidate.name}):`, jobErr.message);
          errors.push(`${candidate.name} at ${job.company}: ${jobErr.message}`);
        }
      }
    }

    // 4. Process Queued LinkedIn Posts
    const posts = await getLinkedInPosts();
    if (posts.length > 0) {
      console.log(`📱 Processing ${posts.length} queued LinkedIn posts`);
      for (const post of posts) {
        try {
          const details = await parseLinkedInPost(post, groq);
          if (!details) {
            await markPostProcessed(post);
            continue;
          }

          let hrEmail = null;
          let apolloName = null;

          if (post.email && isRealPersonEmail(post.email)) {
            hrEmail = post.email;
          } else {
            const contact = await findRecruiterContact({
              company: details.company,
              description: post.text
            });
            if (contact) {
              hrEmail = contact.email;
              apolloName = contact.name;
            }
          }

          if (!hrEmail) {
            console.log(`⏭ Skip LinkedIn post for ${details.company} - no verified recruiter contact`);
            await markPostProcessed(post);
            continue;
          }

          const job = {
            title: details.title || "Dynamics 365 Developer",
            company: details.company || "Enterprise Partner",
            location: details.location || "India",
            url: post.url || "",
            source: "LinkedIn Post",
            description: details.skills || post.text || ""
          };

          for (const candidate of candidates) {
            try {
              const isDuplicate = await alreadySent(candidate.email, hrEmail, job.title);
              if (isDuplicate) {
                continue;
              }

              const { subject, body } = await generateEmail(candidate, job, groq, details.recruiterName || apolloName, true);
              let sent = false;
              let failureReason = null;
              try {
                await sendGmail(candidate, hrEmail, subject, body, job);
                sent = true;
                emailsSent++;
                await markAsSent(candidate.email, hrEmail, job.title);
              } catch (sendErr) {
                emailsFailed++;
                failureReason = sendErr.message;
              }

              await updateSheet(candidate, job, hrEmail, subject, sent, "LinkedIn Post");
              await saveApplication({
                candidateName: candidate.name,
                candidateEmail: candidate.email,
                company: job.company,
                hrEmail,
                subject,
                sent
              });

              results.push({
                candidate: candidate.name,
                company: job.company,
                jobTitle: job.title,
                hrEmail,
                sent,
                source: "LinkedIn Post",
                reason: failureReason
              });

              await new Promise(r => setTimeout(r, 2000));
            } catch (postCandErr) {
              console.log("LinkedIn post candidate error:", postCandErr.message);
            }
          }

          await markPostProcessed(post);
        } catch (postErr) {
          console.log("Post processing error:", postErr.message);
        }
      }
    }

    // 5. Final Diagnostic Response
    const responsePayload = {
      success: true,
      candidates: candidates.length,

      jobsSearched: discovery.jobsSearched,
      jobsFound: discovery.jobsFound,
      d365Matches: discovery.d365Matches,
      duplicateJobs: discovery.duplicateJobs,
      candidateMatches,
      noContact,
      readyToApply,

      emailsSent,
      emailsFailed,

      sourceStats: discovery.sourceStats,
      errors,
      results
    };

    console.log("📊 Application run completed:", JSON.stringify({
      candidates: responsePayload.candidates,
      jobsSearched: responsePayload.jobsSearched,
      jobsFound: responsePayload.jobsFound,
      d365Matches: responsePayload.d365Matches,
      emailsSent: responsePayload.emailsSent
    }));

    return res.json(responsePayload);

  } catch (fatalErr) {
    console.error("Fatal dispatch error:", fatalErr);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: fatalErr.message,
        errors: [fatalErr.message]
      });
    }
  }
};
