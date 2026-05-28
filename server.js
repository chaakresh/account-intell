const https = require("https");

const PORT = process.env.PORT || 3000;
const GITHUB_PAT = process.env.GH_PAT;
const GITHUB_OWNER = "Chaakresh";
const GITHUB_REPO = "account-intell";

if (!GITHUB_PAT) {
  console.error("❌ GH_PAT environment variable not set");
  process.exit(1);
}

// ─── Tiny HTTP server (no Express needed) ────────────────────────────────────
const http = require("http");

const server = http.createServer(async (req, res) => {
  // CORS headers — allow GitHub Pages origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Trigger report
  if (req.method === "POST" && req.url === "/generate") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { company } = JSON.parse(body);
        if (!company) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "company is required" }));
          return;
        }

        console.log(`📊 Triggering report for: ${company}`);

        // Trigger GitHub Actions workflow
        const payload = JSON.stringify({
          ref: "main",
          inputs: { company }
        });

        const options = {
          hostname: "api.github.com",
          path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/generate.yml/dispatches`,
          method: "POST",
          headers: {
            "Authorization": `token ${GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "User-Agent": "account-intell-server"
          }
        };

        const ghReq = https.request(options, (ghRes) => {
          let data = "";
          ghRes.on("data", chunk => { data += chunk; });
          ghRes.on("end", () => {
            if (ghRes.statusCode === 204) {
              console.log(`✅ Workflow triggered for: ${company}`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, company }));
            } else {
              console.error(`❌ GitHub error ${ghRes.statusCode}: ${data}`);
              res.writeHead(ghRes.statusCode, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `GitHub error: ${ghRes.statusCode}`, detail: data }));
            }
          });
        });

        ghReq.on("error", (err) => {
          console.error("❌ Request error:", err.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });

        ghReq.write(payload);
        ghReq.end();

      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
