require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const https = require("https");
const fs    = require("fs");

// ─── ITC Infotech context (mirrors context.py) ────────────────────────────────
const ITC_CONTEXT = `
COMPANY OVERVIEW
ITC Infotech is a wholly-owned subsidiary of ITC Limited. HQ: Bengaluru, India. ~10,000 employees. ~$400M revenue.
CEO: Manas Chakraborty (since Jan 2026). Recent Acquisition: BlazeClan Technologies (Apr 2024) — cloud/APAC.
AI Centre of Excellence: Kolkata.

SERVICE LINES
1. CIO 360 — App Modernization, ERP (S/4HANA), Infra & Digital Workplace, AI-RunOps, QA to QI
2. Industry 4.0 — Digital Twins, OT/Plant Automation, IoT, Supply Chain, Embedded Engineering, Smart Energy, Gen AI
3. DxP (Digital Experience) — PLM Consulting: PTC Windchill, Windchill+, Codebeamer ALM, Arbortext SLM, FlexPLM, S-Series A&D
4. Cloud — Data Analytics, App Modernization, Cloud Infrastructure, CLOUDLYTICS/CSPM

VERTICALS: CPG & Retail ~40% (IKEA, Nike, Heineken, BAT, Coca-Cola), Manufacturing ~25% (Liebherr, KONE, Ferrari, Volvo),
Travel & Hospitality ~15% (Marriott, Four Seasons, Accor), BFSI ~10% (BlackRock, Goldman Sachs), A&D via DxP S-Series.

GEOGRAPHIES: Americas (primary revenue), EMEAI (UK, Germany, Nordics, Middle East), APAC (Singapore, Australia).

KEY RISKS: PTC dependency, mid-size squeeze, APAC competition (Infosys/Versent, Capgemini/Cloud4C), AI margin compression.
KEY OPPORTUNITIES: SAP ECC end-of-maintenance 2027, Windchill→Windchill+ SaaS migration, EU AI Act compliance services,
KSA e-invoicing mandate, TechM BPS retreat, Middle East expansion.

COMPETITORS: TCS, Infosys, Wipro, HCLTech, Cognizant (Tier 1); LTIMindtree, Persistent, Coforge, Mphasis, TechM (mid-tier).

CRITICAL: so_what must ALWAYS name a specific ITCI service line, vertical, platform, or geography. Never write generic statements.
Example GOOD: "PTC's new pricing directly compresses DxP margins on Windchill renewal deals in Americas"
Example BAD: "This could affect ITC Infotech's business"
`;

// ─── Today's date ─────────────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "long", year: "numeric"
  });
}

function nowISO() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T") + "+05:30";
}

// ─── Claude API call ──────────────────────────────────────────────────────────
function claudeCall(prompt, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch(e) { reject(new Error("Parse error: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Section search prompts ───────────────────────────────────────────────────
function sectionPrompts(today) {
  return {
    macro: `Search for today's most important IT services industry news (${today}).
Find 3 specific, verifiable stories. For each, provide: headline, what happened, significance, exact source URLs.
Focus: AI disruption of IT outsourcing, global IT spending, enterprise software market shifts, PLM market news.
Be factual. Only cite real articles published today or yesterday. No speculation.`,

    competitive: `Search for IT services competitor news today (${today}).
Companies: TCS, Infosys, Wipro, HCLTech, Cognizant, LTIMindtree, Persistent, Coforge, Mphasis, Tech Mahindra.
Find 3 specific stories: deal wins, partnerships, acquisitions, strategy announcements, financial results.
For each: company name, what happened, size/scope if mentioned, source URL.`,

    market_structure: `Search for AI companies entering IT services and hyperscaler direct services news today (${today}).
Focus: OpenAI, Anthropic, Google, Microsoft, AWS, Azure GCP expanding into implementation/consulting,
non-traditional players entering IT services, major partnership/alliance announcements between tech giants and SIs.
Find 3 specific stories with source URLs.`,

    client_verticals: `Search for enterprise technology news today (${today}) across these industries:
- CPG & Retail: digital transformation, AI, supply chain technology
- Manufacturing: Industry 4.0, automation, IoT, digital twins
- Travel & Hospitality: property management systems, AI, digital
- BFSI: banking technology, fintech, regulatory IT
- Aerospace & Defense: PLM, MBE, defense technology programs
Find 3 most significant stories with source URLs.`,

    partner_ecosystem: `Search for enterprise software platform news today (${today}).
Focus: PTC (Windchill, Codebeamer, Vuforia), SAP (S/4HANA, ECC), Adobe (AEM, Analytics),
ServiceNow, New Relic, AWS/Azure/GCP partner ecosystem announcements.
Find 3 specific stories: product updates, pricing changes, partnership shifts, vulnerabilities, strategy changes.
Include exact source URLs.`,

    regulatory: `Search for regulatory and geopolitical news affecting IT services today (${today}).
Focus: EU AI Act enforcement updates, DORA compliance, data privacy laws (GDPR, India DPDP),
US-India outsourcing regulations, KSA/Middle East technology mandates, trade policy affecting IT.
Find 3-5 active regulatory items with specific deadlines or enforcement dates and source URLs.`
  };
}

// ─── Gap check ────────────────────────────────────────────────────────────────
async function checkGaps(sections) {
  const summary = Object.entries(sections)
    .map(([k, v]) => `${k.toUpperCase()}: ${v.text.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are reviewing research for an ITC Infotech daily intelligence brief.

Review these sections and identify SPECIFIC data gaps — missing key events, thin sections, missing source URLs, vague claims.

Return ONLY a JSON array. Each item:
{"section": "macro|competitive|market_structure|client_verticals|partner_ecosystem|regulatory", "gap": "one sentence", "query": "specific search query 5-8 words"}

Max 4 gaps. If data is sufficient, return []. Return ONLY valid JSON, no explanation.

SECTIONS:
${summary}`;

  const raw = await claudeCall(prompt, 600);
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    // Extract just the array portion
    const start = clean.indexOf("[");
    const end   = clean.lastIndexOf("]") + 1;
    if (start === -1 || end === 0) return [];
    return JSON.parse(clean.slice(start, end));
  } catch(e) {
    console.log("  Gap check parse failed, skipping.");
    return [];
  }
}

// ─── Claude synthesis → one section ─────────────────────────────────────────
async function synthesizeSection(key, title, research, today) {
  const sourcesText = (research.sources || []).slice(0, 8)
    .map(s => `- ${s.name}: ${s.url}`).join("\n") || "None";

  const prompt = `You are an IT industry analyst writing for ITC Infotech CEO and leadership.
Today: ${today}

${ITC_CONTEXT}

Research for section "${title}":
${research.text.slice(0, 2500)}

Sources found:
${sourcesText}

Generate EXACTLY 3 signals for the "${title}" section.
Return ONLY this JSON object, no explanation, no markdown:
{
  "title": "${title}",
  "signals": [
    {
      "headline": "Factual headline max 12 words",
      "summary": "2 sentences. What happened and why it matters.",
      "severity": "red|amber|green",
      "so_what": "1 sentence naming specific ITCI service line/vertical/geography",
      "action": "1 sentence specific next step",
      "sources": [{"name": "Publication", "url": "https://url"}]
    }
  ]
}

CRITICAL: so_what must name specific ITCI service line or vertical. Never generic.`;

  const raw = await claudeCall(prompt, 1200);
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end   = clean.lastIndexOf("}") + 1;
  if (start === -1 || end === 0) throw new Error(`No JSON for ${key}`);
  return JSON.parse(clean.slice(start, end));
}

// ─── Claude top signals + regulatory ─────────────────────────────────────────
async function synthesizeTopAndRegulatory(builtSections, regulatoryResearch, today) {
  const allSignals = Object.entries(builtSections)
    .flatMap(([k, sec]) => (sec.signals || []).map(s => ({...s, _section: sec.title})));

  const regSources = (regulatoryResearch.sources || []).slice(0, 8)
    .map(s => `- ${s.name}: ${s.url}`).join("\n") || "None";

  const signalsSummary = allSignals.map((s, i) =>
    `${i+1}. [${s._section}] [${s.severity}] ${s.headline}`
  ).join("\n");

  const prompt = `You are an IT industry analyst for ITC Infotech CEO.
Today: ${today}

All signals generated today:
${signalsSummary}

Regulatory research:
${regulatoryResearch.text.slice(0, 2000)}
Sources: ${regSources}

Generate two things and return ONLY this JSON, no markdown:
{
  "top_signals": [
    {
      "section": "Section name",
      "headline": "...",
      "summary": "2 sentences",
      "severity": "red|amber|green",
      "so_what": "1 sentence specific to ITCI service line/vertical",
      "action": "1 sentence",
      "sources": [{"name": "...", "url": "..."}]
    }
  ],
  "regulatory": {
    "last_updated": "${today}",
    "items": [
      {
        "name": "Regulation name",
        "region": "Geography",
        "date": "Deadline or enforcement date",
        "status": "active|upcoming|building",
        "description": "2 sentences: what it is and specific ITCI implication"
      }
    ]
  }
}

top_signals: pick the 4-5 most critical signals from the list above. Copy headline/summary/so_what exactly.
regulatory: 3-5 items with specific deadlines relevant to ITCI geographies.`;

  const raw = await claudeCall(prompt, 2000);
  const clean = raw.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end   = clean.lastIndexOf("}") + 1;
  if (start === -1 || end === 0) throw new Error("No JSON for top/regulatory");
  return JSON.parse(clean.slice(start, end));
}


// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync("research_cache.json")) {
    console.error("❌ research_cache.json not found. Run: node scrape_daily.js first");
    process.exit(1);
  }

  const cache   = JSON.parse(fs.readFileSync("research_cache.json", "utf8"));
  const today   = cache.today || todayIST();
  const sections = cache.sections;

  console.log(`\n🧠 Synthesizing daily brief — ${today}`);
  console.log(`   Cache from: ${cache.scraped_at}`);
  console.log("═".repeat(60));

  const sectionKeys = [
    { key: "macro",            title: "Macro & IT Services" },
    { key: "competitive",      title: "Competitive Intelligence" },
    { key: "market_structure", title: "Market Structure Shifts" },
    { key: "client_verticals", title: "Client Verticals" },
    { key: "partner_ecosystem",title: "Partner & Ecosystem" },
  ];

  const builtSections = {};
  for (const { key, title } of sectionKeys) {
    process.stdout.write(`🧠 [Synthesizing Agent] ${title}...`);
    try {
      builtSections[key] = await synthesizeSection(key, title, sections[key], today);
      console.log(` ✅`);
    } catch(e) {
      console.log(` ⚠️  Failed: ${e.message.slice(0, 80)}`);
      builtSections[key] = { title, signals: [] };
    }
  }

  // Top signals + regulatory
  process.stdout.write(`🧠 [Synthesizing Agent] Top signals & regulatory...`);
  let topAndReg;
  try {
    topAndReg = await synthesizeTopAndRegulatory(builtSections, sections.regulatory, today);
    console.log(` ✅`);
  } catch(e) {
    console.log(` ⚠️  Failed: ${e.message.slice(0, 80)}`);
    topAndReg = { top_signals: [], regulatory: { last_updated: today, items: [] } };
  }

  // Assemble
  const report = {
    generated_at:   nowISO(),
    generated_date: today,
    top_signals:    topAndReg.top_signals || [],
    sections:       builtSections,
    regulatory:     topAndReg.regulatory || { last_updated: today, items: [] }
  };

  fs.writeFileSync("report.json", JSON.stringify(report, null, 2));
  console.log(`\n✅ report.json saved. Top signals: ${report.top_signals.length}`);
  console.log("═".repeat(60));
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
