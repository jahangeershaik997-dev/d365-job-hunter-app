/**
 * D365 Job Hunter - Job Discovery Module
 * 
 * Multi-source job discovery engine with Adzuna REST API integration,
 * stable deduplication, strict D365 relevance scoring, and diagnostic telemetry.
 */

const ADZUNA_BASE_URL = "https://api.adzuna.com/v1/api/jobs/in/search";
const DEFAULT_TIMEOUT_MS = 7000;

// Configurable D365 Search Queries
const D365_QUERIES = [
  "Dynamics 365",
  "Dynamics 365 CRM",
  "D365 Developer",
  "Dynamics 365 CE",
  "Microsoft Dynamics CRM",
  "Dynamics CRM Developer",
  "Power Platform Developer",
  "Dynamics 365 Technical Consultant"
];

// Configurable Target Locations in India / Remote
const TARGET_LOCATIONS = [
  "Hyderabad",
  "Bangalore",
  "Bengaluru",
  "Chennai",
  "Pune",
  "Mumbai",
  "Delhi",
  "Noida",
  "Gurgaon",
  "India",
  "Remote"
];

// Relevance Keyword Dictionaries
const POSITIVE_KEYWORD_WEIGHTS = [
  // Tier 1: Core D365 / CRM (Highest weight)
  { term: "dynamics 365", weight: 12 },
  { term: "dynamics crm", weight: 12 },
  { term: "d365 crm", weight: 12 },
  { term: "d365 ce", weight: 12 },
  { term: "dynamics ce", weight: 10 },
  { term: "d365", weight: 10 },
  { term: "customer engagement", weight: 8 },
  { term: "microsoft dynamics", weight: 8 },

  // Tier 2: Power Platform / Ecosystem
  { term: "power platform", weight: 7 },
  { term: "power apps", weight: 6 },
  { term: "powerapps", weight: 6 },
  { term: "power automate", weight: 6 },
  { term: "dataverse", weight: 6 },
  { term: "dynamics f&o", weight: 5 },
  { term: "dynamics finance", weight: 5 },
  { term: "business central", weight: 5 },

  // Tier 3: Technical Skills / Extension
  { term: "c#.net", weight: 4 },
  { term: "plugins", weight: 4 },
  { term: "fetchxml", weight: 4 },
  { term: "pcf controls", weight: 4 },
  { term: "model-driven", weight: 4 },
  { term: "xrmtoolbox", weight: 3 },
  { term: "azure functions", weight: 3 }
];

const NEGATIVE_EXCLUSION_KEYWORDS = [
  "intern",
  "internship",
  "fresher",
  "trainee",
  "graduate trainee",
  "unpaid",
  "telecaller",
  "customer care executive",
  "sales executive",
  "bpo",
  "data entry"
];

/**
 * Strips HTML tags and excessive whitespace
 */
function cleanText(str) {
  if (!str) return "";
  return String(str)
    .replace(/<[^>]*>?/gm, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes string for deduplication comparison
 */
function normalizeString(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 80);
}

/**
 * Generates a stable deduplication key for a job
 */
function getJobDeduplicationKey(job) {
  if (job.source && job.id) {
    return `${job.source.toLowerCase()}:${String(job.id).trim().toLowerCase()}`;
  }
  const comp = normalizeString(job.company);
  const title = normalizeString(job.title);
  const loc = normalizeString(job.location);
  const url = (job.url || "").trim().toLowerCase();
  return `${comp}|${title}|${loc}|${url}`;
}

/**
 * Normalizes any raw job object into the standard schema:
 * {
 *   id,
 *   title,
 *   company,
 *   location,
 *   url,
 *   source,
 *   description,
 *   postedAt,
 *   salaryMin,
 *   salaryMax
 * }
 */
function normalizeAdzunaJob(raw) {
  const companyName = raw.company?.display_name || (typeof raw.company === "string" ? raw.company : "") || "Confidential";
  const locationName = raw.location?.display_name || (Array.isArray(raw.location?.area) ? raw.location.area.join(", ") : (typeof raw.location === "string" ? raw.location : "India"));
  
  return {
    id: raw.id ? String(raw.id) : "",
    title: cleanText(raw.title || "Dynamics 365 Developer"),
    company: cleanText(companyName),
    location: cleanText(locationName),
    url: raw.redirect_url || raw.url || "",
    source: "Adzuna",
    description: cleanText(raw.description || ""),
    postedAt: raw.created || new Date().toISOString(),
    salaryMin: typeof raw.salary_min === "number" ? raw.salary_min : null,
    salaryMax: typeof raw.salary_max === "number" ? raw.salary_max : null
  };
}

/**
 * Calculates D365 relevance score based on title & description
 */
function calculateD365Relevance(job) {
  const titleLower = (job.title || "").toLowerCase();
  const descLower = (job.description || "").toLowerCase();
  const fullText = `${titleLower} ${descLower}`;

  // Check hard exclusions
  for (const neg of NEGATIVE_EXCLUSION_KEYWORDS) {
    // Only exclude if found in title as a role descriptor
    const titleRegex = new RegExp(`\\b${neg}\\b`, "i");
    if (titleRegex.test(titleLower)) {
      return { score: -100, isRelevant: false, reason: `Excluded keyword: ${neg}` };
    }
  }

  let score = 0;
  const matchedKeywords = [];

  for (const item of POSITIVE_KEYWORD_WEIGHTS) {
    const term = item.term;
    const inTitle = titleLower.includes(term);
    const inDesc = descLower.includes(term);

    if (inTitle) {
      score += item.weight * 2; // Double weight for title matches
      matchedKeywords.push(`title:${term}`);
    } else if (inDesc) {
      score += item.weight;
      matchedKeywords.push(`desc:${term}`);
    }
  }

  // Pure generic CRM match without any Dynamics/D365/PowerPlatform context is weak
  const hasCoreD365 = fullText.includes("dynamics") || 
                      fullText.includes("d365") || 
                      fullText.includes("power platform") ||
                      fullText.includes("powerapps") ||
                      fullText.includes("dataverse");

  if (!hasCoreD365) {
    score = Math.floor(score * 0.3); // Heavily discount non-Dynamics CRM jobs
  }

  // Minimum threshold for considering a job D365-relevant
  const isRelevant = hasCoreD365 && score >= 6;

  return {
    score,
    isRelevant,
    matchedKeywords
  };
}

/**
 * Helper to fetch with timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Fetches real jobs from official Adzuna REST API
 */
async function fetchAdzunaJobs(options = {}) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  const stats = {
    searched: 0,
    found: 0,
    errors: []
  };

  if (!appId || !appKey) {
    const msg = "ADZUNA credentials are not configured (ADZUNA_APP_ID and ADZUNA_APP_KEY missing).";
    stats.errors.push(msg);
    return {
      jobs: [],
      stats,
      error: msg
    };
  }

  const queries = options.queries || D365_QUERIES.slice(0, 4); // Top high-yield queries
  const locations = options.locations || ["India", "Hyderabad", "Bangalore"];
  const resultsPerPage = options.resultsPerPage || 20;
  const maxDaysOld = options.maxDaysOld || 30;

  const rawJobs = [];

  // Iterate over query combinations
  for (const query of queries) {
    for (const location of locations) {
      stats.searched++;
      try {
        const url = new URL(`${ADZUNA_BASE_URL}/1`);
        url.searchParams.set("app_id", appId);
        url.searchParams.set("app_key", appKey);
        url.searchParams.set("results_per_page", String(resultsPerPage));
        url.searchParams.set("what", query);
        url.searchParams.set("where", location);
        url.searchParams.set("content-type", "application/json");
        url.searchParams.set("max_days_old", String(maxDaysOld));

        const res = await fetchWithTimeout(url.toString(), {
          headers: { "Accept": "application/json" }
        }, DEFAULT_TIMEOUT_MS);

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          console.log(`⚠️ Adzuna HTTP ${res.status} for query="${query}" where="${location}": ${errText.substring(0, 100)}`);
          stats.errors.push(`Adzuna HTTP ${res.status} on "${query}" in "${location}"`);
          continue;
        }

        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
        stats.found += results.length;
        
        for (const item of results) {
          rawJobs.push(normalizeAdzunaJob(item));
        }

      } catch (err) {
        console.log(`Adzuna search error for "${query}" in "${location}":`, err.message);
        stats.errors.push(`Search "${query}" in "${location}": ${err.message}`);
      }
    }
  }

  return {
    jobs: rawJobs,
    stats,
    error: stats.errors.length > 0 && rawJobs.length === 0 ? stats.errors.join("; ") : null
  };
}

/**
 * Isolated Mock Jobs for local offline testing (enabled ONLY when USE_MOCK_JOBS=true)
 */
function getMockJobs() {
  return [
    {
      id: "mock-101",
      title: "Senior Dynamics 365 CRM Developer",
      company: "CloudTech Dynamics Solutions",
      location: "Hyderabad, India",
      url: "https://example.com/jobs/d365-sr-dev",
      source: "Mock",
      description: "Looking for Senior D365 CE developer with C#.NET plugins, Power Platform, Azure Functions, and Dataverse experience. Contact: recruiter.ananya@cloudtechdynamics.com",
      postedAt: new Date().toISOString(),
      salaryMin: 1200000,
      salaryMax: 1800000
    },
    {
      id: "mock-102",
      title: "Microsoft Dynamics 365 CE / Power Platform Consultant",
      company: "Innovate Enterprise Systems",
      location: "Bangalore, India",
      url: "https://example.com/jobs/d365-consultant",
      source: "Mock",
      description: "MS Dynamics 365 CE customization, Power Apps, Power Automate flows, and Web API integration for enterprise clients. Contact: talent.priya@innovatesystems.io",
      postedAt: new Date().toISOString(),
      salaryMin: 1000000,
      salaryMax: 1600000
    },
    {
      id: "mock-103",
      title: "D365 Technical Consultant",
      company: "Apex Business Technologies",
      location: "Pune, India",
      url: "https://example.com/jobs/d365-tech-consultant",
      source: "Mock",
      description: "Lead Dynamics 365 CRM and Power Platform implementations with CI/CD in Azure DevOps.",
      postedAt: new Date().toISOString(),
      salaryMin: 1400000,
      salaryMax: 2200000
    }
  ];
}

/**
 * Primary Job Discovery Engine
 * 
 * Performs:
 * 1. Multi-source search (Adzuna + optional mock mode)
 * 2. Stable deduplication across sources
 * 3. Strict D365 relevance scoring & filtering
 * 4. Ranking by relevance score
 * 5. Returns comprehensive diagnostic stats
 */
async function discoverJobs(options = {}) {
  const useMock = process.env.USE_MOCK_JOBS === "true";
  const diagnostics = {
    jobsSearched: 0,
    jobsFound: 0,
    d365Matches: 0,
    duplicateJobs: 0,
    sourceStats: {
      adzuna: {
        searched: 0,
        found: 0,
        errors: []
      }
    },
    errors: []
  };

  let allDiscovered = [];

  if (useMock) {
    console.log("🧪 USE_MOCK_JOBS is enabled - Loading mock job fixtures for testing");
    const mockList = getMockJobs();
    diagnostics.jobsSearched += 1;
    diagnostics.jobsFound += mockList.length;
    diagnostics.sourceStats.mock = { searched: 1, found: mockList.length };
    allDiscovered.push(...mockList);
  } else {
    // 1. Fetch Adzuna Jobs
    const adzunaResult = await fetchAdzunaJobs(options);
    diagnostics.jobsSearched += adzunaResult.stats.searched;
    diagnostics.jobsFound += adzunaResult.stats.found;
    diagnostics.sourceStats.adzuna = adzunaResult.stats;

    if (adzunaResult.error) {
      diagnostics.errors.push(adzunaResult.error);
    }

    allDiscovered.push(...adzunaResult.jobs);
  }

  // 2. Stable Deduplication
  const seenKeys = new Set();
  const deduplicatedJobs = [];

  for (const job of allDiscovered) {
    const key = getJobDeduplicationKey(job);
    if (seenKeys.has(key)) {
      diagnostics.duplicateJobs++;
      continue;
    }
    seenKeys.add(key);
    deduplicatedJobs.push(job);
  }

  // 3. D365 Relevance Filtering & Scoring
  const rankedMatches = [];

  for (const job of deduplicatedJobs) {
    const relevance = calculateD365Relevance(job);
    if (relevance.isRelevant) {
      diagnostics.d365Matches++;
      rankedMatches.push({
        ...job,
        relevanceScore: relevance.score,
        matchedKeywords: relevance.matchedKeywords
      });
    }
  }

  // 4. Rank highest score first
  rankedMatches.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

  return {
    jobs: rankedMatches,
    jobsSearched: diagnostics.jobsSearched,
    jobsFound: diagnostics.jobsFound,
    d365Matches: diagnostics.d365Matches,
    duplicateJobs: diagnostics.duplicateJobs,
    sourceStats: diagnostics.sourceStats,
    errors: diagnostics.errors
  };
}

module.exports = {
  discoverJobs,
  fetchAdzunaJobs,
  calculateD365Relevance,
  getJobDeduplicationKey,
  cleanText,
  D365_QUERIES,
  TARGET_LOCATIONS
};
