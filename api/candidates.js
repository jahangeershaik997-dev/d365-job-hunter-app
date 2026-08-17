const { resolveUser } = require("../middleware/auth");

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;

module.exports = async (req, res) => {
  try {
    // Require a valid authenticated session.
    const resolved = await resolveUser(req);
    const user = resolved?.user || null;

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Not logged in"
      });
    }

    if (!JSONBIN_BIN_ID || !JSONBIN_MASTER_KEY) {
      console.error("JSONBin environment variables are missing");
      return res.status(500).json({
        success: false,
        error: "Candidate storage is not configured"
      });
    }

    const resBin = await fetch(
      `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`,
      {
        headers: {
          "X-Master-Key": JSONBIN_MASTER_KEY
        }
      }
    );

    if (!resBin.ok) {
      const errorText = await resBin.text().catch(() => "");

      console.error(
        `Candidates JSONBin error: HTTP ${resBin.status} ${resBin.statusText} ${errorText.substring(0, 300)}`
      );

      return res.status(500).json({
        success: false,
        error: "Failed to fetch candidates"
      });
    }

    const data = await resBin.json();
    const records = Array.isArray(data.record) ? data.record : [];

    // Support both OAuth token formats used by the application.
    const candidates = records
      .filter(c => !c.init && c.email && c.name)
      .map(c => {
        const refreshToken =
          c.refreshToken ||
          c.tokens?.refresh_token ||
          null;

        return {
          ...c,
          refreshToken
        };
      })
      .filter(c => !!c.refreshToken);

    console.log(`Candidates endpoint: ${candidates.length} valid candidates`);

    // Never expose OAuth tokens to the browser.
    return res.json({
      success: true,
      candidates: candidates.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        experience: c.experience,
        role: c.role,
        registeredAt: c.registeredAt
      }))
    });

  } catch (e) {
    console.error("Candidates endpoint error:", e.message);

    if (e.message?.toLowerCase().includes("session") ||
        e.message?.toLowerCase().includes("redis")) {
      return res.status(401).json({
        success: false,
        error: "Session unavailable. Please log in again."
      });
    }

    return res.status(500).json({
      success: false,
      error: "Unable to load candidates"
    });
  }
};