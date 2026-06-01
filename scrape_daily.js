require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require("https");
const fs   = require("fs");

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// ─── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 3, delayMs = 8000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      const is429  = err.message && err.message.includes("429");
      const isRecit = err.message && err.message.includes("RECITATION");
      if ((is429 || isRecit) && i < retries - 1) {
        console.log(`\n⚠️  ${isRecit ? "RECITATION" : "Rate limit"} on ${label}. Retry ${i+2}/${retries}...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else throw err;
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
    const candidates = result.response.candidates || [];

    if (candidates[0]?.finishReason === "RECITATION")
      throw new Error("RECITATION_BLOCK");

    const text = result.response.text();
    const sources = [];
    try {
      const chunks = candidates[0]?.groundingMetadata?.groundingChunks || [];
      chunks.forEach(c => {
        if (c.web?.uri) sources.push({ name: c.web.title || c.web.uri, url: c.web.uri });
      });
    } catch(e) {}
    return { text, sources };
  }, label);
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


// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const today = todayIST();
  console.log(`\n🔍 Scraping daily intelligence — ${today}`);
  console.log("═".repeat(60));

  const prompts  = sectionPrompts(today);
  const sections = {};

  // Step 1: Gemini research — 6 sections
  const sectionList = [
    { key: "macro",            label: "Macro & IT Services" },
    { key: "competitive",      label: "Competitive Intelligence" },
    { key: "market_structure", label: "Market Structure Shifts" },
    { key: "client_verticals", label: "Client Verticals" },
    { key: "partner_ecosystem",label: "Partner & Ecosystem" },
    { key: "regulatory",       label: "Regulatory & Geopolitical" },
  ];

  for (const { key, label } of sectionList) {
    process.stdout.write(`⏳ [Web Scraping Agent] ${label}...`);
    try {
      sections[key] = await research(prompts[key], label);
      console.log(` ✅ (${sections[key].sources.length} sources)`);
    } catch(e) {
      console.log(` ⚠️  Failed: ${e.message.slice(0, 60)}`);
      sections[key] = { text: `Research unavailable for ${label}.`, sources: [] };
    }
  }

  // Step 2: Gap check
  process.stdout.write(`\n🔍 [Synthesizing Agent] Checking for gaps...`);
  const gaps = await checkGaps(sections);
  console.log(` ✅ (${gaps.length} gaps found)`);

  // Step 3: Fill gaps
  for (const gap of gaps) {
    process.stdout.write(`⏳ [Web Scraping Agent] Filling: ${gap.gap.slice(0, 50)}...`);
    try {
      const fill = await research(
        `Search specifically for: ${gap.query}. Find the most recent article with source URL.`,
        gap.gap
      );
      sections[gap.section].text += `\n\nADDITIONAL: ${fill.text.slice(0, 800)}`;
      sections[gap.section].sources.push(...fill.sources);
      console.log(` ✅`);
    } catch(e) { console.log(` ⚠️  Skipped`); }
  }

  // Step 4: Save cache
  const cache = { today, scraped_at: nowISO(), sections };
  fs.writeFileSync("research_cache.json", JSON.stringify(cache, null, 2));
  console.log(`\n✅ research_cache.json saved. Run: node synthesize_daily.js`);
  console.log("═".repeat(60));
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
