const https = require("https");
const http  = require("http");

const PORT         = process.env.PORT || 3000;
const GITHUB_PAT   = process.env.GH_PAT;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const GITHUB_OWNER = "Chaakresh";
const GITHUB_REPO  = "account-intell";

if (!GITHUB_PAT) { console.error("❌ GH_PAT not set"); process.exit(1); }
if (!OPENAI_KEY)  { console.warn("⚠️  OPENAI_API_KEY not set — canonicalize will be limited"); }

// ─── Helper: HTTPS POST ───────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const opts = {
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(payload) }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Canonicalize company name via OpenAI ────────────────────────────────────
async function canonicalize(rawName) {
  if (!OPENAI_KEY) {
    return { officialName: rawName, industry: "Unknown", country: "Unknown", confidence: "low" };
  }
  const prompt = `Given the company name or abbreviation "${rawName}", return the official full company name, primary industry, and headquarters country.

Return ONLY valid JSON in this exact format, nothing else:
{"officialName":"Full Official Name","industry":"Primary Industry","country":"Country","ticker":"TICKER or null"}

Examples:
- "apple" → {"officialName":"Apple Inc.","industry":"Consumer Electronics & Software","country":"USA","ticker":"AAPL"}
- "msft" → {"officialName":"Microsoft Corporation","industry":"Technology","country":"USA","ticker":"MSFT"}
- "boeing" → {"officialName":"The Boeing Company","industry":"Aerospace & Defense","country":"USA","ticker":"BA"}
- "ikea" → {"officialName":"IKEA Group (Ingka Group)","industry":"Home Furnishings Retail","country":"Sweden","ticker":null}`;

  try {
    const res = await httpsPost(
      "api.openai.com",
      "/v1/chat/completions",
      {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "account-intell-server"
      },
      {
        model: "gpt-4o-mini",
        max_tokens: 150,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      }
    );
    const data = JSON.parse(res.body);
    const text = data.choices?.[0]?.message?.content?.trim() || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error("Canonicalize error:", e.message);
    return { officialName: rawName, industry: "Unknown", country: "Unknown", ticker: null };
  }
}

// ─── Trigger GitHub Actions ───────────────────────────────────────────────────
async function triggerWorkflow(company) {
  const payload = JSON.stringify({ ref: "main", inputs: { company } });
  const res = await httpsPost(
    "api.github.com",
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/generate.yml/dispatches`,
    {
      "Authorization": `token ${GITHUB_PAT}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "account-intell-server"
    },
    payload
  );
  return res;
}

// ─── Parse request body ───────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(e); }
    });
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const json = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    return json(200, { status: "ok" });
  }

  // ── POST /canonicalize ─────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/canonicalize") {
    try {
      const { company } = await parseBody(req);
      if (!company) return json(400, { error: "company is required" });
      console.log(`🔍 Canonicalizing: ${company}`);
      const result = await canonicalize(company);
      console.log(`✅ Canonical: ${result.officialName}`);
      return json(200, result);
    } catch(e) {
      return json(400, { error: e.message });
    }
  }

  // ── POST /generate ─────────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/generate") {
    try {
      const { company } = await parseBody(req);
      if (!company) return json(400, { error: "company is required" });
      console.log(`📊 Triggering report for: ${company}`);
      const ghRes = await triggerWorkflow(company);
      if (ghRes.status === 204) {
        console.log(`✅ Workflow triggered: ${company}`);
        return json(200, { success: true, company });
      } else {
        console.error(`❌ GitHub error ${ghRes.status}: ${ghRes.body}`);
        return json(ghRes.status, { error: `GitHub error: ${ghRes.status}`, detail: ghRes.body });
      }
    } catch(e) {
      return json(500, { error: e.message });
    }
  }

  return json(404, { error: "Not found" });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
