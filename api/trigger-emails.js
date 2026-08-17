const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { tailorResumeText, generatePDF, uploadTailoredResume } = require("./tailor-resume");
const { saveApplication } = require("../lib/history");
const { alreadySent, markAsSent } = require("../lib/sent-tracker");

const JSONBIN_BIN_ID     = process.env.JSONBIN_BIN_ID     || "6a7fe014f5f4af5e29189def";
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY || "$2a$10$mOTOfSBdMCPsMoeb7FIaVubVgsRJqsgyheEbJc2nZ6aZ5p3cKzVJa";
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const GROQ_MODEL         = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const SHEET_ID           = process.env.GOOGLE_SHEET_ID;
const LINKEDIN_BIN_ID    = process.env.LINKEDIN_BIN_ID;

async function getCandidates() {
  try {
    const res = await fetch(
      `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`,
      { headers: { "X-Master-Key": JSONBIN_MASTER_KEY } }
    );
    if (!res.ok) { console.log(`trigger-emails getCandidates: JSONBin HTTP ${res.status}`); return []; }
    const data = await res.json();
    const records = Array.isArray(data.record) ? data.record : [];
    return records
      .filter(c => !c.init && c.email)
      .map(c => {
        const rt = c.refreshToken || (c.tokens && c.tokens.refresh_token) || null;
        return { ...c, refreshToken: rt };
      })
      .filter(c => !!c.refreshToken);
  } catch (e) { console.log("trigger-emails getCandidates error:", e.message); return []; }
}

function isRealPersonEmail(email) {
  if (!email) return false;
  const local = (email.split("@")[0] || "").toLowerCase();
  const blacklist = ["hr","careers","career","recruitment","jobs","job","info","contact","admin","support","hello","team","noreply","no-reply","hiring","apply","staffing","humanresources","enquiry","enquiries","recruiting","joinus","getintouch","talent","resumes","resume"];
  if (local.includes(".")) { const p = local.split("."); if (blacklist.includes(p[0])) return false; return true; }
  if (blacklist.includes(local)) return false;
  if (local.length >= 3 && /^[a-z]+$/.test(local)) return true;
  return false;
}

async function parseJobPost(text, groq) {
  if (!groq) return null;
  const prompt = `Extract job details from this recruiter post. Return ONLY valid JSON with no explanation.\n\nPOST TEXT:\n"${text.substring(0, 800)}"\n\nReturn:\n{\n  "title": "exact job title",\n  "company": "real company name",\n  "location": "city/country or India",\n  "recruiterName": "first name only or null",\n  "recruiterEmail": "email@domain.com or null",\n  "skills": ["skill1", "skill2", "skill3"]\n}`;
  try {
    const response = await groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 300 });
    const t = response.choices[0].message.content;
    const json = t.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const jobDetails = JSON.parse(json);
    if (!jobDetails.recruiterEmail) {
      const found = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).find(e => isRealPersonEmail(e));
      if (found) { jobDetails.recruiterEmail = found; console.log("Auto-detected email:", found); }
    }
    if (!jobDetails.company || jobDetails.company === "Company") {
      if (jobDetails.recruiterEmail) {
        const domain = jobDetails.recruiterEmail.split("@")[1] || "";
        jobDetails.company = domain.replace(/\.(com|in|io|co|net|org)$/, "").replace(/-/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        console.log("Company from domain:", jobDetails.company);
      }
    }
    return jobDetails;
  } catch (e) { console.log("parseJobPost error:", e.message); return null; }
}

async function parseImagePost(imageBase64, groq) {
  if (!groq) return null;
  try {
    const response = await groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageBase64, detail: "high" } }, { type: "text", text: 'Extract job details from this image. Return ONLY valid JSON:\n{\n  "title": "job title",\n  "company": "company name",\n  "location": "location",\n  "recruiterName": "recruiter first name if visible",\n  "recruiterEmail": "email if visible",\n  "skills": ["skill1"]\n}' }] }], max_tokens: 500 });
    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) { const parsed = JSON.parse(json); console.log("Image parsed:", JSON.stringify(parsed)); return parsed; }
    return null;
  } catch (e) { console.log("Image parse error:", e.message); return null; }
}

async function generateEmail(candidate, job, groq, recruiterName) {
  const greeting = recruiterName ? `Dear ${recruiterName}` : "Dear Hiring Manager";
  const fallback = {
    subject: `${candidate.experience || "5"}+ Years D365 CRM Expert | ${job.title || "D365 Developer"} Application - ${candidate.name}`,
    body: `${greeting},\n\nI am writing to express my strong interest in the ${job.title || "D365 Developer"} position at ${job.company}. With ${candidate.experience || "5"}+ years of specialized experience in Microsoft Dynamics 365 CRM and Power Platform development, I have engineered enterprise solutions utilizing C#.NET plugins, Dataverse, Azure Functions, and automated workflows.\n\nMy technical foundation aligns seamlessly with your requirements. Please find my resume attached.\n\nBest regards,\n${candidate.name}\n\u2709\ufe0f ${candidate.email}`
  };
  if (!groq) { console.log("Groq not configured - using fallback email"); return fallback; }
  const styles = ["formal and authoritative","confident and direct","enthusiastic and engaging","concise and impactful"];
  const opens = [`I came across this opportunity and felt compelled to reach out`,`Your posting caught my attention immediately`,`I'm reaching out regarding the ${job.title} role`,`Having reviewed the requirements for this position`];
  const style = styles[Math.floor(Math.random() * styles.length)];
  const opening = opens[Math.floor(Math.random() * opens.length)];
  const prompt = `Write a UNIQUE ${style} job application email.\n\nOpening line to use: "${opening}"\n\nCANDIDATE:\nName: ${candidate.name}\nExperience: ${candidate.experience || "5"}+ years Microsoft Dynamics 365 CRM\nPhone: ${candidate.phone || "available on request"}\nKey Skills: ${Array.isArray(candidate.skills) ? candidate.skills.join(", ") : "D365 CRM, C#.NET, Power Platform"}\nClients: ${candidate.clients || "Enterprise CRM implementations"}\nCertifications: ${candidate.certifications || ""}\nSummary: ${candidate.summary || ""}\nResume: ${(candidate.resumeText || "").substring(0, 300)}\n\nJOB:\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || "India"}\nSkills: ${Array.isArray(job.skills) ? job.skills.join(", ") : job.skills || ""}\n\nRULES:\n- ONLY facts from profile, never invent\n- Max 130 words\n- Contact at end: \ud83d\udcf1 ${candidate.phone || "Available on request"} | \u2709\ufe0f ${candidate.email}\n\nFORMAT:\nSUBJECT: [subject]\n\nBODY:\n${greeting},\n\n[email body]\n\nBest regards,\n${candidate.name}`;
  try {
    const response = await groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 600 });
    const text = response.choices[0].message.content;
    const lines = text.split("\n");
    let subject = ""; const bodyLines = []; let foundSubject = false;
    for (const line of lines) {
      if (line.toLowerCase().startsWith("subject:")) { subject = line.replace(/^subject:\s*/i, "").trim(); foundSubject = true; }
      else if (foundSubject) { if (line.trim().toLowerCase() === "body:") continue; bodyLines.push(line); }
    }
    if (subject && bodyLines.length > 0) return { subject, body: bodyLines.join("\n").trim() };
    return { subject: `${candidate.experience || "5"}+ Years D365 CRM Developer | ${job.title} at ${job.company}`, body: text.trim() };
  } catch (err) { console.log(`Groq generateEmail error (${GROQ_MODEL}) for ${candidate.name}:`, err.message); return fallback; }
}

async function sendGmail(candidate, to, subject, body, job) {
  if (!candidate.refreshToken) throw new Error(`${candidate.name} has no refreshToken`);
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "https://d365-job-hunter-app.vercel.app/auth/callback");
  oauth2Client.setCredentials({ refresh_token: candidate.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  let resumeBuffer = null;
  let resumeFilename = `${(candidate.name || "Candidate").replace(/\s/g, "_")}_${(job.company || "Company").replace(/\s/g, "_")}_Resume.pdf`;
  let resumeMimeType = "application/pdf";
  try {
    console.log(`\ud83d\udcc4 Tailoring resume for ${candidate.name} -> ${job.company}...`);
    const tailoredData = await tailorResumeText(candidate, job).catch(() => null);
    if (tailoredData) { const pdf = await generatePDF(tailoredData, candidate, job).catch(() => null); if (pdf) { resumeBuffer = pdf; console.log(`Tailored PDF generated for ${candidate.name}`); uploadTailoredResume(pdf, candidate.id, job.company).catch(e => console.log("Blob upload error:", e.message)); } }
    if (!resumeBuffer && candidate.resume && candidate.resume.url) { const r = await fetch(candidate.resume.url); const arr = await r.arrayBuffer(); resumeBuffer = Buffer.from(arr); resumeFilename = candidate.resume.filename || resumeFilename; resumeMimeType = candidate.resume.mimeType || resumeMimeType; }
  } catch (e) {
    console.log(`Resume error for ${candidate.name}:`, e.message);
    if (candidate.resume && candidate.resume.url) { try { const r = await fetch(candidate.resume.url); const arr = await r.arrayBuffer(); resumeBuffer = Buffer.from(arr); resumeFilename = candidate.resume.filename || resumeFilename; resumeMimeType = candidate.resume.mimeType || resumeMimeType; } catch (e2) {} }
  }
  const boundary = "boundary_" + Date.now();
  let mimeMessage;
  if (resumeBuffer) {
    mimeMessage = [`From: ${candidate.name} <${candidate.email}>`,`To: ${to}`,`Subject: ${subject}`,`MIME-Version: 1.0`,`Content-Type: multipart/mixed; boundary="${boundary}"`,``,`--${boundary}`,`Content-Type: text/plain; charset=utf-8`,``,body,``,`--${boundary}`,`Content-Type: ${resumeMimeType}`,`Content-Transfer-Encoding: base64`,`Content-Disposition: attachment; filename="${resumeFilename}"`,``,resumeBuffer.toString("base64"),`--${boundary}--`].join("\r\n");
  } else {
    mimeMessage = [`From: ${candidate.name} <${candidate.email}>`,`To: ${to}`,`Subject: ${subject}`,`Content-Type: text/plain; charset=utf-8`,``,body].join("\r\n");
  }
  const raw = Buffer.from(mimeMessage).toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`Sent from ${candidate.email} to ${to} ${resumeBuffer ? "(with resume)" : "(no resume)"}`);
}

async function updateSheet(candidate, job, hrEmail, subject, sent, source) {
  try {
    const rawSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!rawSa || !SHEET_ID) return;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawSa), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: "Sheet1!A:K", valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { values: [[job.title||"",job.company||"",job.location||"",job.url||"",source||"LinkedIn Post",hrEmail||"",candidate.name||"",subject||"",sent?"Yes":"No",new Date().toLocaleDateString("en-IN"),sent?"Applied":"Failed"]] } });
    console.log(`Sheet updated: ${candidate.name} -> ${job.company}`);
  } catch (e) { console.log("Sheet update failed:", e.message); }
}

async function saveToLinkedInBin(post) {
  try {
    if (!LINKEDIN_BIN_ID) return;
    const res = await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}/latest`, { headers: { "X-Master-Key": JSONBIN_MASTER_KEY } });
    if (!res.ok) return;
    const data = await res.json();
    const posts = Array.isArray(data.record) ? data.record.filter(p => !p.init) : [];
    posts.unshift(post);
    await fetch(`https://api.jsonbin.io/v3/b/${LINKEDIN_BIN_ID}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_MASTER_KEY }, body: JSON.stringify(posts.slice(0, 50)) });
  } catch (e) { console.log("saveToLinkedInBin error:", e.message); }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { text, imageBase64, email, url, type, candidateId } = req.body;
  const results = [];
  let groq = null;
  if (GROQ_API_KEY) { try { groq = new Groq({ apiKey: GROQ_API_KEY }); } catch (e) { console.log("Groq init error:", e.message); } }
  try {
    let candidates = await getCandidates();
    if (candidates.length === 0) return res.json({ success: false, error: "No candidates registered yet!" });
    if (candidateId && candidateId !== "all") {
      candidates = candidates.filter(c => c.id === candidateId);
      if (candidates.length === 0) return res.json({ success: false, error: "Candidate not found or not authenticated." });
    }
    let jobDetails = null;
    if (type === "image" && imageBase64) jobDetails = await parseImagePost(imageBase64, groq);
    else if (text) jobDetails = await parseJobPost(text, groq);
    if (!jobDetails) return res.json({ success: false, error: "Could not extract job details. Please add more detail to the post." });
    console.log("Parsed job:", JSON.stringify(jobDetails));
    let hrEmail = null;
    let recruiterName = jobDetails.recruiterName || null;
    if (email && isRealPersonEmail(email)) { hrEmail = email; console.log(`Using provided email: ${email}`); }
    if (!hrEmail && jobDetails.recruiterEmail && isRealPersonEmail(jobDetails.recruiterEmail)) { hrEmail = jobDetails.recruiterEmail; console.log(`Using email from post: ${hrEmail}`); }
    if (!hrEmail && jobDetails.company && process.env.APOLLO_API_KEY) {
      console.log(`Apollo searching HR at: ${jobDetails.company}`);
      try {
        const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), 6000);
        const apolloRes = await fetch("https://api.apollo.io/api/v1/mixed_people/search", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "X-Api-Key": process.env.APOLLO_API_KEY }, body: JSON.stringify({ q_organization_name: jobDetails.company, person_titles: ["Technical Recruiter","IT Recruiter","HR Manager","Talent Acquisition Manager","Recruitment Manager","Hiring Manager"], per_page: 5 }) });
        clearTimeout(tid);
        if (apolloRes.ok) { const apolloData = await apolloRes.json(); for (const person of (apolloData.people || [])) { if (person.email && isRealPersonEmail(person.email)) { hrEmail = person.email; recruiterName = person.first_name || null; console.log(`Apollo found: ${recruiterName} - ${hrEmail}`); break; } } }
        else console.log(`Apollo HTTP ${apolloRes.status}`);
      } catch (e) { console.log("Apollo search error:", e.message); }
    }
    const job = { title: jobDetails.title || "D365 Developer", company: jobDetails.company || "Enterprise Partner", location: jobDetails.location || "India", url: url || "", skills: jobDetails.skills || [] };
    saveToLinkedInBin({ text: text?.substring(0, 200) || "Image post", company: job.company, hrEmail, url, processed: !!hrEmail, emailsSent: hrEmail ? candidates.length : 0, addedAt: new Date().toISOString() }).catch(() => {});
    if (!hrEmail) return res.json({ success: false, jobDetails, error: `Job parsed: ${jobDetails.title} at ${jobDetails.company}. No verified recruiter email found. Please enter the recruiter email manually.` });
    for (const candidate of candidates) {
      try {
        const isDuplicate = await alreadySent(candidate.email, hrEmail, job.title);
        if (isDuplicate) { console.log(`Skip: ${candidate.name} already sent to ${hrEmail} for "${job.title}"`); results.push({ candidate: candidate.name, company: job.company, hrEmail, sent: false, reason: "Already sent" }); continue; }
        const { subject, body } = await generateEmail(candidate, job, groq, recruiterName);
        let sent = false; let failureReason = null;
        try { await sendGmail(candidate, hrEmail, subject, body, job); sent = true; await markAsSent(candidate.email, hrEmail, job.title); }
        catch (sendErr) { console.log(`Gmail ${candidate.name}:`, sendErr.message); failureReason = "Email dispatch failed. Check server logs."; }
        await updateSheet(candidate, job, hrEmail, subject, sent, "LinkedIn Post");
        await saveApplication({ candidateName: candidate.name, candidateEmail: candidate.email, company: job.company, hrEmail, subject, sent });
        results.push({ candidate: candidate.name, company: job.company, hrEmail, sent, reason: failureReason });
        await new Promise(r => setTimeout(r, 2000));
      } catch (candErr) { console.log(`Candidate dispatch error (${candidate.name}):`, candErr.message); results.push({ candidate: candidate.name, company: job.company, hrEmail, sent: false, reason: "Dispatch error. Check server logs." }); }
    }
    res.json({ success: true, jobDetails, hrEmail, emailsSent: results.filter(r => r.sent).length, totalCandidates: candidates.length, results });
  } catch (e) {
    console.error("trigger-emails fatal:", e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Application failed: AI service unavailable. Check server logs." });
  }
};
