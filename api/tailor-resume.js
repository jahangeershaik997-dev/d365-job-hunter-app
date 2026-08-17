const Groq = require("groq-sdk");
const { put } = require("@vercel/blob");
const PDFDocument = require("pdfkit");

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

async function tailorResumeText(candidate, job) {
  if (!process.env.GROQ_API_KEY) return null;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const prompt = `You are an expert resume writer.

CANDIDATE PROFILE:
Name: ${candidate.name}
Experience: ${candidate.experience} years Microsoft Dynamics 365 CRM
Phone: ${candidate.phone || ""}
Email: ${candidate.email}
Skills: ${Array.isArray(candidate.skills) ? candidate.skills.join(", ") : candidate.skills || "D365 CRM, C#.NET, Power Platform"}
Clients: ${candidate.clients || "Enterprise CRM implementations"}
Certifications: ${candidate.certifications || ""}
Summary: ${candidate.summary || ""}
Resume: ${(candidate.resumeText || "").substring(0, 1500)}

JOB:
Title: ${job.title}
Company: ${job.company}
Requirements: ${Array.isArray(job.skills) ? job.skills.join(", ") : job.skills || job.description || ""}

RULES:
- Only use REAL facts from candidate profile
- NEVER invent experience clients or skills
- Optimize for ATS with JD keywords
- Put most relevant skills FIRST

Return ONLY valid JSON no explanation:
{
  "summary": "2-3 sentence professional summary tailored to this JD",
  "skills": ["skill1", "skill2", "skill3", "skill4", "skill5", "skill6"],
  "experience": [
    {
      "company": "company name",
      "role": "job title",
      "period": "date range",
      "bullets": ["achievement 1 with JD keywords", "achievement 2", "achievement 3"]
    }
  ],
  "certifications": "certifications string"
}`;

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000
  });

  try {
    const text = response.choices[0].message.content;
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch(e) {
    console.log("Resume tailor parse error:", e.message);
    return null;
  }
}

async function generatePDF(resumeData, candidate, job) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 50, right: 50 }
      });

      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      doc.fontSize(22).fillColor("#0078D4").font("Helvetica-Bold")
         .text(candidate.name, { align: "center" });
      doc.fontSize(12).fillColor("#555").font("Helvetica")
         .text(`${job.title} | ${candidate.experience}+ Years Experience`, { align: "center" });
      doc.fontSize(10).fillColor("#777")
         .text(`${candidate.phone || "Available on request"} | ${candidate.email}`, { align: "center" });
      doc.moveDown(0.5)
         .moveTo(50, doc.y).lineTo(545, doc.y)
         .strokeColor("#0078D4").lineWidth(2).stroke();
      doc.moveDown(0.5);

      // Summary
      doc.fontSize(11).fillColor("#0078D4").font("Helvetica-Bold")
         .text("PROFESSIONAL SUMMARY");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(1).stroke();
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#333").font("Helvetica")
         .text(resumeData.summary || candidate.summary || "", { align: "justify" });
      doc.moveDown(0.8);

      // Skills
      doc.fontSize(11).fillColor("#0078D4").font("Helvetica-Bold")
         .text("KEY SKILLS");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(1).stroke();
      doc.moveDown(0.3);
      const skills = resumeData.skills || candidate.skills || [];
      const skillText = Array.isArray(skills) ? skills.join(" • ") : skills;
      doc.fontSize(10).fillColor("#333").font("Helvetica").text(skillText);
      doc.moveDown(0.8);

      // Experience
      doc.fontSize(11).fillColor("#0078D4").font("Helvetica-Bold")
         .text("PROFESSIONAL EXPERIENCE");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(1).stroke();
      doc.moveDown(0.3);

      const experiences = resumeData.experience || [];
      experiences.forEach(exp => {
        doc.fontSize(11).fillColor("#333").font("Helvetica-Bold")
           .text(`${exp.role} | ${exp.company}`);
        if (exp.period) {
          doc.fontSize(10).fillColor("#777").font("Helvetica").text(exp.period);
        }
        doc.moveDown(0.2);
        const bullets = exp.bullets || [];
        bullets.forEach(bullet => {
          doc.fontSize(10).fillColor("#333").font("Helvetica")
             .text(`• ${bullet}`, { indent: 15 });
        });
        doc.moveDown(0.5);
      });

      // Certifications
      if (resumeData.certifications || candidate.certifications) {
        doc.fontSize(11).fillColor("#0078D4").font("Helvetica-Bold")
           .text("CERTIFICATIONS");
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(1).stroke();
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor("#333").font("Helvetica")
           .text(resumeData.certifications || candidate.certifications || "");
      }

      doc.end();
    } catch(e) {
      reject(e);
    }
  });
}

async function uploadTailoredResume(pdfBuffer, candidateId, jobCompany) {
  try {
    const filename = `tailored_${candidateId}_${jobCompany.replace(/\s/g,"_")}_${Date.now()}.pdf`;
    const blob = await put(
      `tailored-resumes/${filename}`,
      pdfBuffer,
      { access: "public", contentType: "application/pdf", token: process.env.BLOB_READ_WRITE_TOKEN }
    );
    return { url: blob.url, filename };
  } catch(e) {
    console.log("Blob upload error:", e.message);
    return null;
  }
}

module.exports = { tailorResumeText, generatePDF, uploadTailoredResume };
