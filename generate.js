require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require("https");
const fs = require("fs");
const path = require("path");

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const company = process.env.COMPANY || process.argv[2];

if (!company) {
  console.error("Usage: COMPANY='IKEA' node generate.js");
  process.exit(1);
}

const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");

// ─── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 3, delayMs = 8000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      const is429 = err.message && err.message.includes("429");
      if (is429 && i < retries - 1) {
        console.log(`⚠️  Rate limit on ${label}. Retrying in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else { throw err; }
    }
  }
}

// ─── Gemini research ──────────────────────────────────────────────────────────
async function research(prompt, label) {
  return withRetry(async () => {
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }, label);
}

// ─── Strip markdown ───────────────────────────────────────────────────────────
function clean(text) {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Section prompts ──────────────────────────────────────────────────────────
function prompts(c) {
  return {
    s1: `You are a senior sales researcher. Research "${c}". Return ONLY the data below. No intro sentence. Start directly with data. Be factual. Cite numbers. Say "Not publicly available" if unknown.

1. REVENUE & MARGIN: Last reported annual revenue and operating/net margin (with year)
2. REVENUE TREND: Revenue and margin for last 3-5 years (table format)
3. EMPLOYEES: Total global headcount. Break down by high-cost locations (US, UK, Germany, Australia, Canada) if available.
4. INDIA PRESENCE: India GCC, delivery center, or R&D center? If yes, headcount and location.
5. RECENT NEWS: Last 6 months. Split: (a) Product News (b) Company News.
6. M&A ACTIVITY: Acquisitions, mergers, divestitures or investment rounds in last 2 years.
7. OWNERSHIP STRUCTURE: Public (ticker+exchange), Private, PE-backed, or Family-owned.
8. KEY COMPETITORS: Top 3-5 direct competitors.`,

    s2: `You are a senior sales researcher. Research "${c}" corporate strategy. No intro sentence. Start directly with data. Use direct executive quotes where available.

1. CORPORATE VISION & DIRECTION: Where is leadership taking the company in next 12-18 months? Reference earnings calls, CEO interviews, annual reports.
2. BIG STRATEGIC INITIATIVES: Specific announced programs — cost transformation, expansion, sustainability mandates, restructuring. Include program names and targets.
3. TECHNOLOGY STRATEGY: AI adoption stance, cloud migration, platform consolidation, vendor relationships, build vs buy signals.`,

    s3: `You are a senior sales researcher. Research "${c}" leadership. No intro sentence. Start directly with data.

1. KEY DECISION MAKERS: CEO, CFO, CTO/CDO, COO — full name, tenure, brief background (2 lines max each).
2. RECENT LEADERSHIP CHANGES: C-suite or VP changes in last 12 months. Flag as timing signals.
3. ORG STRUCTURE SIGNALS: Technology centralized globally or federated by region/BU?
4. BOARD COMPOSITION: Key board members, PE representation, notable strategic investors.`,

    s4: `You are a senior sales researcher. Research "${c}" buying signals and pain points. No intro sentence. Evidence-based only.

1. FINANCIAL STRESS SIGNALS: Margin compression, cost-cutting, layoffs, restructuring in last 12 months.
2. TECHNOLOGY PAIN SIGNALS: Legacy system mentions, failed projects, tech debt in news or earnings.
3. OPERATIONAL PAIN SIGNALS: Supply chain issues, compliance challenges, scaling problems.
4. HIRING SIGNALS: Bulk hiring (build signal) or hiring freeze (cost pressure signal)?
5. TIMING TRIGGERS: New leadership, post-M&A integration, regulatory deadline, announced transformation.`,

    s5: `You are a senior sales researcher. Research "${c}" vendor and competitive landscape. No intro sentence.

1. CURRENT TECH VENDORS: Known ERP, CRM, PLM, HCM, cloud, data platforms. Source from job postings, press releases, case studies.
2. KNOWN SI/CONSULTING PARTNERS: Accenture, TCS, Infosys, Deloitte etc. Source from press releases or LinkedIn.
3. PROCUREMENT SIGNALS: Public RFPs, analyst reviews, job postings referencing platforms being evaluated.
4. COMPETITIVE DYNAMICS: Top 2-3 competitors. Gaining or losing market share?`,
  };
}

// ─── Claude synthesis ─────────────────────────────────────────────────────────
async function synthesize(c, sections) {
  const context = Object.entries(sections).map(([k,v]) => `SECTION ${k.toUpperCase()}:\n${v}`).join("\n\n");

  const prompt = `You are an expert B2B sales strategist. Based on research below, generate Section 6 of a pre-sales intelligence brief. Use plain text only. No markdown.

${context}

SECTION 6 — SALES PLAY & CONVERSATION STARTERS:

1. RECOMMENDED PITCH ANGLE: Single strongest hook. (Cost / Transformation / GTM / Compliance / AI play). Explain WHY in 3-4 lines citing specific findings above.

2. CONVERSATION OPENER QUESTIONS: 4-5 specific, informed questions referencing real things happening at the company.

3. LANDMINES TO AVOID: 3-4 specific topics that could kill the conversation. Be direct.

4. SUGGESTED NEXT STEP: Most logical first meeting ask. Be specific.

5. BEST ENTRY POINT: Single most likely first contact. Name the role and person. Complete your answer fully.`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch(e) { reject(new Error("Parse error: " + data)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Parse markdown table to HTML ────────────────────────────────────────────
function parseTable(lines) {
  const rows = lines.filter(l => l.trim().startsWith("|") && !l.trim().match(/^[|\s:-]+$/));
  if (rows.length === 0) return "";
  let html = `<div class="tbl-wrap"><table class="data-table">`;
  rows.forEach((row, i) => {
    const cells = row.split("|").map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
    const tag = i === 0 ? "th" : "td";
    html += `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
  });
  html += `</table></div>`;
  return html;
}

// ─── Format section content to HTML ──────────────────────────────────────────
function formatContent(text) {
  const lines = text.split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) { i++; continue; }

    // Detect markdown table block
    if (trimmed.startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      html += parseTable(tableLines);
      continue;
    }

    // Numbered section header: "1. REVENUE & MARGIN: content"
    const numMatch = trimmed.match(/^(\d+)\.\s+([A-Z][A-Z\s&\/()]+?):\s*(.*)/);
    if (numMatch) {
      const rest = numMatch[3].trim();
      // Collect continuation lines (indented or bullet lines that follow)
      let bodyLines = rest ? [rest] : [];
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next) { i++; break; }
        if (/^\d+\.\s+[A-Z]/.test(next)) break; // next numbered item
        bodyLines.push(next);
        i++;
      }
      // Build body — check if body contains table
      let bodyHtml = "";
      let j = 0;
      while (j < bodyLines.length) {
        const bl = bodyLines[j];
        if (bl.startsWith("|")) {
          const tbl = [];
          while (j < bodyLines.length && bodyLines[j].startsWith("|")) { tbl.push(bodyLines[j]); j++; }
          bodyHtml += parseTable(tbl);
        } else if (/^[*•-]\s+/.test(bl)) {
          bodyHtml += `<div class="content-bullet"><span class="bullet-dot"></span><span>${bl.replace(/^[*•-]\s+/, "")}</span></div>`;
          j++;
        } else {
          bodyHtml += `<div class="content-text">${bl}</div>`;
          j++;
        }
      }
      html += `<div class="content-item">
        <div class="content-num">${numMatch[1]}</div>
        <div class="content-body">
          <div class="content-label">${numMatch[2].trim()}</div>
          ${bodyHtml}
        </div>
      </div>`;
      continue;
    }

    // Bullet items (*, -, •)
    if (/^[*•-]\s+/.test(trimmed)) {
      html += `<div class="content-bullet"><span class="bullet-dot"></span><span>${trimmed.replace(/^[*•-]\s+/, "")}</span></div>`;
      i++; continue;
    }

    // Regular text
    html += `<div class="content-text">${trimmed}</div>`;
    i++;
  }
  return html;
}

// ─── Build HTML report ────────────────────────────────────────────────────────
function buildHTML(company, sections) {
  const generated = new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" });
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");

  const sectionDefs = [
    { key: "s1", id: "snapshot",    label: "Company Snapshot",              icon: "🏢" },
    { key: "s2", id: "strategy",    label: "Strategic Direction",           icon: "🎯" },
    { key: "s3", id: "leadership",  label: "Leadership & Org",              icon: "👥" },
    { key: "s4", id: "signals",     label: "Buying Signals",                icon: "📡" },
    { key: "s5", id: "vendors",     label: "Competitive & Vendors",         icon: "🔍" },
    { key: "s6", id: "salesplay",   label: "Sales Play",                    icon: "⚡" },
  ];

  const navPills = sectionDefs.map(s =>
    `<a href="#${s.id}">${s.icon} ${s.label}</a>`
  ).join("");

  const sectionCards = sectionDefs.map(s => `
    <div class="section" id="${s.id}">
      <div class="section-hdr">${s.icon} ${s.label}</div>
      <div class="card">
        <div class="card-body">${formatContent(clean(sections[s.key] || ""))}</div>
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>ITC Infotech · ${company} · Account Intelligence</title>
<style>
:root {
  --navy:   #1F3864;
  --blue:   #2E74B5;
  --lblue:  #EBF3FB;
  --vblue:  #9DC3E6;
  --amber:  #BF8A14;
  --bg:     #F0F2F5;
  --card:   #FFFFFF;
  --border: #E2E5EC;
  --t1:     #1A1F36;
  --t2:     #4A5568;
  --t3:     #9AA3B0;
  --radius: 10px;
  --shadow: 0 1px 3px rgba(0,0,0,.06), 0 2px 10px rgba(0,0,0,.05);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  background: var(--bg); color: var(--t1);
  font-size: 14px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  padding-bottom: 80px;
}
.top-bar {
  position: sticky; top: 0; z-index: 100;
  background: var(--navy);
  padding: 12px 16px 0;
  box-shadow: 0 2px 12px rgba(0,0,0,.18);
}
.top-bar-row { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 10px; }
.top-brand { color: #fff; font-size: 15px; font-weight: 600; line-height: 1.2; }
.top-sub   { color: var(--vblue); font-size: 10px; margin-top: 2px; }
.top-date  { color: var(--vblue); font-size: 10px; text-align: right; white-space: nowrap; margin-top: 2px; }
.sec-nav {
  display: flex; gap: 4px;
  overflow-x: auto; padding-bottom: 10px;
  scrollbar-width: none;
}
.sec-nav::-webkit-scrollbar { display: none; }
.sec-nav a {
  flex-shrink: 0; color: rgba(255,255,255,.65);
  font-size: 11px; font-weight: 500; text-decoration: none;
  padding: 4px 10px; border-radius: 20px;
  border: 1px solid rgba(255,255,255,.2);
  transition: all .15s; white-space: nowrap;
}
.sec-nav a:hover { background: rgba(255,255,255,.15); color: #fff; border-color: rgba(255,255,255,.4); }

/* Hero */
.hero {
  background: linear-gradient(135deg, var(--navy) 0%, #2E74B5 100%);
  padding: 24px 16px 20px;
}
.hero-company { color: #fff; font-size: 22px; font-weight: 700; margin-bottom: 4px; }
.hero-label   { color: var(--vblue); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 10px; }
.hero-meta    { display: flex; gap: 10px; flex-wrap: wrap; }
.hero-badge   { background: rgba(255,255,255,.12); color: #fff; font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }

/* PDF Banner */
.pdf-banner {
  background: var(--lblue);
  border-bottom: 1px solid #C4DCF0;
  padding: 10px 16px;
  display: flex; justify-content: space-between; align-items: center;
}
.pdf-banner-text { font-size: 12px; color: var(--navy); }
.pdf-btn {
  background: var(--navy); color: #fff;
  font-size: 11px; font-weight: 600;
  padding: 6px 14px; border-radius: 20px;
  text-decoration: none; white-space: nowrap;
}

/* Sections */
.section { padding: 20px 14px 0; }
.section-hdr {
  font-size: 11px; font-weight: 700; color: var(--navy);
  letter-spacing: .1em; text-transform: uppercase; margin-bottom: 10px;
}
.card {
  background: var(--card);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden; margin-bottom: 12px;
}
.card-body { padding: 14px 16px; }

/* Content formatting */
.content-item {
  display: flex; gap: 12px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--border);
}
.content-item:last-child { border-bottom: none; }
.content-num {
  flex-shrink: 0; width: 22px; height: 22px;
  background: var(--navy); color: #fff; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; margin-top: 1px;
}
.content-body { flex: 1; }
.content-label { font-size: 11px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
.content-text  { font-size: 13px; color: var(--t2); line-height: 1.6; }
.content-bullet {
  display: flex; gap: 8px; font-size: 12.5px; color: var(--t2);
  line-height: 1.5; padding: 3px 0;
}
.bullet-dot { flex-shrink: 0; width: 5px; height: 5px; background: var(--blue); border-radius: 50%; margin-top: 7px; }
.tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 8px 0; }
.data-table { border-collapse: collapse; width: 100%; font-size: 12px; }
.data-table th { background: var(--navy); color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; font-weight: 600; white-space: nowrap; }
.data-table td { padding: 7px 10px; border-bottom: 0.5px solid var(--border); color: var(--t2); vertical-align: top; }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:nth-child(even) td { background: #FAFBFC; }

/* Sales play section — special styling */
#salesplay .card { border-top: 3px solid var(--blue); }

/* Footer */
.report-footer {
  margin: 24px 14px 8px;
  padding: 16px;
  background: var(--card);
  border-radius: var(--radius);
  border-top: 2px solid var(--navy);
}
.footer-disclaimer { font-size: 11px; color: var(--t3); line-height: 1.7; margin-bottom: 8px; }
.footer-meta { font-size: 10px; color: var(--t3); text-align: center; font-style: italic; }

/* Print / PDF styles */
@media print {
  .top-bar, .pdf-banner { position: relative; }
  .sec-nav { display: none; }
  body { padding-bottom: 0; }
  .section { padding: 12px 10px 0; }
  .card { break-inside: avoid; }
}
</style>
</head>
<body>

<!-- HEADER -->
<div class="top-bar">
  <div class="top-bar-row">
    <div>
      <div class="top-brand">ITC Infotech</div>
      <div class="top-sub">Account Intelligence · Internal · Sales Only</div>
    </div>
    <div class="top-date">${generated}</div>
  </div>
  <div class="sec-nav">
    ${navPills}
  </div>
</div>

<!-- HERO -->
<div class="hero">
  <div class="hero-label">Pre-Sales Intelligence Brief</div>
  <div class="hero-company">${company}</div>
  <div class="hero-meta" id="hero-meta-badges">
    <span class="hero-badge">📅 ${generated}</span>
    <span class="hero-badge" id="ownership-badge">⚠️ Verify before use</span>
  </div>
</div>

<!-- PDF DOWNLOAD BANNER -->
<div class="pdf-banner">
  <div class="pdf-banner-text">📄 Download full report as PDF</div>
  <a class="pdf-btn" href="${slug}.pdf" download>Download PDF →</a>
</div>

<!-- SECTIONS -->
${sectionCards}

<!-- FOOTER -->
<div class="report-footer">
  <div class="footer-disclaimer">This report was generated with AI assistance. Data is sourced from publicly available information including company websites, press releases, earnings calls, and news sources. AI tools can introduce errors. Cross-check any data point you intend to act on. Do not share outside ITC Infotech.</div>
  <div class="footer-meta">ITC Infotech · Account Intelligence Engine v0.1 · ${generated}</div>
</div>

<script>
(function() {
  const s1 = document.querySelector("#snapshot .card-body");
  const badge = document.getElementById("ownership-badge");
  if (!s1 || !badge) return;
  const t = s1.innerText.toLowerCase();
  if (t.includes("nasdaq") || t.includes("nyse") || t.includes("publicly traded") || t.includes("listed on") || t.includes("stock exchange")) {
    badge.textContent = "📈 Public Company";
  } else if (t.includes("private equity") || t.includes("pe-backed") || t.includes("pe backed")) {
    badge.textContent = "💼 PE-Backed";
  } else if (t.includes("privately held") || t.includes("private company") || t.includes("family-owned") || t.includes("not publicly traded")) {
    badge.textContent = "🔒 Private Company";
  } else {
    badge.textContent = "⚠️ Verify before use";
  }
})();
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📊 Generating report for: ${company}`);
  const p = prompts(company);
  const sections = {};

  const sectionList = [
    { key: "s1", label: "Company Snapshot" },
    { key: "s2", label: "Strategic Direction" },
    { key: "s3", label: "Leadership & Org" },
    { key: "s4", label: "Buying Signals" },
    { key: "s5", label: "Competitive & Vendors" },
  ];

  for (const { key, label } of sectionList) {
    process.stdout.write(`⏳ ${label}...`);
    sections[key] = await research(p[key], label);
    console.log(" ✅");
  }

  process.stdout.write(`🧠 Claude: Sales Play...`);
  sections.s6 = await synthesize(company, sections);
  console.log(" ✅");

  const html = buildHTML(company, sections);
  if (!fs.existsSync("reports")) fs.mkdirSync("reports");
  const outPath = path.join("reports", `${slug}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`\n✅ Report saved: ${outPath}`);
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});