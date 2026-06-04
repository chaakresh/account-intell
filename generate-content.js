require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require("https");
const fs = require("fs");
const path = require("path");

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const company = process.env.COMPANY || process.argv[2];

if (!company) {
  console.error("Usage: COMPANY='IKEA' node generate-content.js");
  process.exit(1);
}

const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");

// ─── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 3, delayMs = 8000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < retries - 1) {
        process.stdout.write(` ⚠ retry ${i + 1}...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else throw e;
    }
  }
}

// ─── Gemini research (returns text + sources) ─────────────────────────────────
async function research(prompt, label, isRetryForRecitation = false) {
  return withRetry(async () => {
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(prompt);
    const response = result.response;

    if (response.promptFeedback?.blockReason) {
      throw new Error(`Blocked: ${response.promptFeedback.blockReason}`);
    }
    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("No candidates returned");

    if (candidate.finishReason === "RECITATION" && !isRetryForRecitation) {
      process.stdout.write(" [RECITATION — retrying without grounding]");
      return research(prompt, label, true);
    }

    const text = candidate.content?.parts?.map(p => p.text || "").join("") || "";
    const sources = [];
    if (candidate.groundingMetadata?.groundingChunks) {
      for (const chunk of candidate.groundingMetadata.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          sources.push({ url: chunk.web.uri, title: chunk.web.title });
        }
      }
    }
    return { text, sources };
  }, label);
}

// ─── Section prompts ──────────────────────────────────────────────────────────
function prompts(c) {
  return {
    s1: `Research ${c} for a B2B sales intelligence brief. Provide structured factual information on:
1. REVENUE & FINANCIALS: Latest revenue figures, growth rates, profitability, margin trends, guidance
2. EMPLOYEE COUNT & LOCATIONS: Global headcount, key office locations, India presence/GCC
3. RECENT NEWS & EVENTS: Last 90 days — acquisitions, partnerships, leadership changes, product launches
4. M&A ACTIVITY: Recent acquisitions or divestitures (last 2 years)
5. OWNERSHIP STRUCTURE: Public/private, parent company, PE ownership, major shareholders
6. KEY COMPETITORS: Top 3-5 direct competitors with brief context

Use web search. Include specific numbers, dates, and source references. Do not use filler phrases.`,

    s2: `Research ${c}'s strategic direction for a B2B sales intelligence brief:
1. CORPORATE VISION & PRIORITIES: Stated strategy, CEO messaging, investor day themes
2. MAJOR STRATEGIC INITIATIVES: Top 3-5 programs underway (digital transformation, market expansion, cost programs)
3. TECHNOLOGY STRATEGY: Cloud adoption, AI/ML investments, ERP/PLM/supply chain modernization plans
4. GEOGRAPHIC EXPANSION: New markets, India strategy, nearshore/offshore plans

Use web search. Be specific — cite initiatives by name, dollar amounts committed, timelines announced.`,

    s3: `Research ${c}'s leadership and organizational structure for a B2B sales intelligence brief:
1. C-SUITE EXECUTIVES: CEO, CFO, CTO, COO, CPO — name, tenure in role, prior company
2. KEY DECISION MAKERS: CIO, CDO, VP Engineering, VP IT, VP Procurement — who controls tech buying
3. RECENT LEADERSHIP CHANGES: Arrivals and departures in last 12 months
4. ORGANIZATIONAL STRUCTURE: Business units, how IT/tech decisions are made, centralized vs decentralized
5. BOARD & INVESTORS: Notable board members, key investors if private

Format each executive as:
[Role]: [Name]
Tenure: [time in role]
Background: [1-2 line prior background]

Use web search. Flag any uncertainty about current role status.`,

    s4: `Analyze ${c} for B2B sales buying signals and pain indicators:
1. FINANCIAL TRIGGERS: Cost pressure signs, restructuring, capex changes, margin squeeze, revenue miss
2. TECHNOLOGY TRIGGERS: Legacy system end-of-life, failed implementations, tech debt mentions, cloud mandates
3. OPERATIONAL TRIGGERS: Supply chain issues, regulatory compliance gaps, ESG/sustainability pressures, quality incidents
4. HIRING SIGNALS: Recent job postings for tech/transformation roles (cite specific roles if found)
5. TIMING TRIGGERS: Upcoming contract renewals, fiscal year timing, announced transformation programs with timelines

Use web search. Prioritize signals from last 6 months. Be specific — cite dollar amounts, dates, job titles.`,

    s5: `Research ${c}'s technology vendor landscape and competitive dynamics:
1. CURRENT TECH VENDORS: Known ERP (SAP/Oracle/MS), PLM, CRM, cloud, SI partners
2. SYSTEM INTEGRATOR RELATIONSHIPS: Known SI partners, GSIs they work with, exclusivity indicators
3. PROCUREMENT SIGNALS: RFP activity, contract awards, vendor consolidation signals
4. COMPETITIVE DYNAMICS: How ${c} competes vs peers, differentiation strategy, where they're losing/winning
5. ITC INFOTECH FIT: Where ITC Infotech's capabilities (PLM/Windchill, S4HANA, cloud, Industry 4.0) could land

Use web search. Include specific product names, contract values if public, renewal dates if known.`
  };
}

// ─── Claude API call helper ───────────────────────────────────────────────────
function claudeCall(prompt, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── OpenAI API call (model-agnostic) ────────────────────────────────────────
function gptCall(prompt, maxTokens = 2000, model = "gpt-4o") {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Claude gap checker ───────────────────────────────────────────────────────
async function checkGaps(c, sections) {
  const context = Object.entries(sections)
    .map(([k, v]) => `SECTION ${k.toUpperCase()}:\n${v.text}`)
    .join("\n\n");

  const prompt = `You are reviewing a B2B sales intelligence brief for ${c}. Identify up to 5 CRITICAL missing data points that would materially affect a sales conversation.

RESEARCH SO FAR:
${context}

Return ONLY valid JSON array (no markdown):
[{"section":"s1","gap":"specific missing data point","searchQuery":"google search query to find it"}]

Focus on: revenue figures, key decision makers with names, recent major initiatives, tech stack specifics, known pain points. Only flag genuinely missing items, not items that are present but vague.`;

  const raw = await claudeCall(prompt, 1000);
  try {
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
  } catch (e) {
    return [];
  }
}

// ─── Targeted gap fill ────────────────────────────────────────────────────────
async function fillGap(gap) {
  const prompt = `Search for: ${gap.searchQuery || gap.gap}

Find specific, factual information to fill this gap in a sales intelligence brief.
Return 2-4 sentences of factual content only. No hedging phrases. Just the facts.`;
  return research(prompt, `Gap: ${gap.gap.slice(0, 40)}`);
}

// ─── Leadership departure verification ───────────────────────────────────────
async function verifyLeadershipDepartures(c, s3text) {
  const prompt = `Verify current status of executives mentioned below for ${c}. Search for any recent leadership changes, departures, or new appointments not reflected in this research.

CURRENT RESEARCH:
${s3text.slice(0, 2000)}

Search specifically for: "${c} CEO departure", "${c} leadership change 2024 2025", "${c} executive left"

Return one paragraph (3-5 sentences) summarizing: (1) which executives appear confirmed still in role, (2) any confirmed departures found, (3) any new appointments found. Be specific with names and dates.`;

  return research(prompt, "Leadership verification");
}

// ─── Structured Sales Play synthesis (Claude → JSON) ─────────────────────────
async function synthesizeSalesPlay(c, sections) {
  const context = Object.entries(sections)
    .filter(([k]) => k !== "s6")
    .map(([k, v]) => `SECTION ${k.toUpperCase()}:\n${v.text}`)
    .join("\n\n");

  const prompt = `You are an expert B2B sales strategist at ITC Infotech. Based on the research below about ${c}, generate a structured sales play.

ITC INFOTECH CONTEXT:
- Service lines: CIO 360 (App Modernization, SAP S/4HANA, Infra, AI-RunOps), Industry 4.0 (Digital Twins, IoT, Supply Chain), DxP/PLM (PTC Windchill, Codebeamer, FlexPLM), Cloud (CLOUDLYTICS, Data Analytics)
- Verticals: CPG & Retail ~40%, Manufacturing ~25%, T&H ~15%, BFSI ~10%, A&D via DxP
- Key opportunities: SAP ECC EOL 2027, Windchill→SaaS migration, EU AI Act, Middle East expansion

RESEARCH:
${context}

Return ONLY valid JSON (no markdown, no explanation):
{
  "pitch": {
    "title": "4-6 word play type (e.g. Cost Transformation Play, SAP S/4HANA Migration Play)",
    "body": "3-4 sentences explaining the single strongest hook, citing specific findings from the research. Name the ITC Infotech service line."
  },
  "openers": [
    "Specific informed question referencing something real at this company?",
    "Another specific question?",
    "Third question?",
    "Fourth question?"
  ],
  "landmines": [
    { "title": "Topic to avoid", "text": "Why this kills the conversation — be direct." },
    { "title": "Another landmine", "text": "Explanation." },
    { "title": "Third landmine", "text": "Explanation." }
  ],
  "nextStep": "Most logical first meeting ask. Be specific — what to ask for, who to involve, what agenda.",
  "entry": {
    "name": "Full name of best entry contact, or role title if name unknown",
    "role": "Their exact title",
    "text": "Why this person is the best entry point and how to approach them."
  }
}`;

  const raw = await claudeCall(prompt, 2000);
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
}

// ─── Format Agent: structured typed-items JSON (GPT-4o-mini) ─────────────────
async function formatSectionsStructured(sections) {
  const labelMap = {
    s1: "Company Snapshot", s2: "Strategic Direction",
    s3: "Leadership & Org",  s4: "Buying Signals", s5: "Competitive & Vendors"
  };
  const keys = ["s1", "s2", "s3", "s4", "s5"];

  const blocks = keys
    .filter(k => sections[k] && sections[k].text)
    .map(k => `=== ${k.toUpperCase()} (${labelMap[k]}) ===\n${sections[k].text}`)
    .join("\n\n---\n\n");

  const prompt = `You are a content structurer for a B2B sales intelligence report. Parse the research sections below into structured JSON. DO NOT change, add, or remove any factual content — all names, numbers, dates, quotes, and URLs must remain exactly as written.

OUTPUT SCHEMA — return ONLY valid JSON, no markdown fences:
{
  "s1": { "items": [ITEM] },
  "s2": { "items": [ITEM] },
  "s3": { "items": [ITEM], "people": [PERSON] },
  "s4": { "items": [ITEM] },
  "s5": { "items": [ITEM] }
}

ITEM — one of these shapes:
  Numbered subsection : { "num": 1, "label": "LABEL IN ALL CAPS", "body": [BLOCK] }
  Gap fill block      : { "type": "gapfill", "note": "qualifier if present, else empty string", "text": "content" }
  Leadership verify   : { "type": "leadershipVerification", "text": "content" }
  Departed executive  : { "type": "departed", "text": "content" }

BLOCK — one of these shapes (inside a numbered item's "body" array):
  Paragraph  : { "type": "text",   "text": "full paragraph text" }
  Bullet     : { "type": "bullet", "text": "text WITHOUT leading dash or asterisk" }
  Table      : { "type": "table",  "headers": ["Col1","Col2"], "rows": [["val","val"]] }

PERSON (for s3 "people" array — extract ALL named executives):
  { "name": "Full Name", "role": "Exact title", "tenure": "time in role or empty string", "background": "1-2 line background or empty string", "details": ["any extra detail lines"] }

RULES:
1. Every numbered subsection header (e.g. "1. REVENUE & FINANCIALS:") becomes one numbered ITEM.
2. All content under that header goes into "body" as text / bullet / table BLOCKs.
3. Special blocks ([GAP FILL...], [LEADERSHIP VERIFICATION], [DEPARTED...]) become top-level ITEMs — NOT nested inside a numbered item's body.
4. For s3: extract every named executive into the "people" array. Look for "Role: Name", bullet lines beginning with a title, or "Name — Role" patterns.
5. Preserve any [[CF:type:note]] markers verbatim inside text strings — do not alter or remove them.
6. Do not invent, summarize, or drop any content.
7. If a section has no numbered subsections, wrap all content under a single item with num:1 and the section name as label.

SECTIONS TO PARSE:
${blocks}`;

  const raw = await gptCall(prompt, 14000, "gpt-4o-mini");
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
}

// ─── GPT-4o confidence audit ──────────────────────────────────────────────────
async function auditConfidence(c, structuredSections) {
  // Build flat text per section from structured items for audit input
  const flatText = {};
  for (const [k, sec] of Object.entries(structuredSections)) {
    const lines = [];
    for (const item of sec.items || []) {
      if (item.text) lines.push(item.text);
      for (const block of item.body || []) {
        if (block.text) lines.push(block.text);
      }
    }
    flatText[k] = lines.join(" ");
  }

  const context = Object.entries(flatText)
    .map(([k, t]) => `SECTION ${k.toUpperCase()}:\n${t}`)
    .join("\n\n");

  const prompt = `You are a fact-checking analyst reviewing a sales intelligence brief about ${c}.

Identify up to 15 specific claims that should be flagged for a sales leader's awareness — data that could be embarrassing or wrong if used in a conversation.

Flag types:
- "inferred"   : logically deduced but not directly stated in public sources
- "unverified" : specific claim that could not be confirmed from public sources
- "assumed"    : general industry assumption applied to this specific company
- "outdated"   : data that may be stale (older than 12 months or pre-2024)

Return ONLY valid JSON array (no markdown):
[{"section":"s1","type":"inferred","quote":"exact phrase from the text (10-50 words)","note":"why this is flagged"}]

The "quote" MUST be an exact substring from the research text — do not paraphrase.

RESEARCH:
${context}`;

  const raw = await gptCall(prompt, 3000, "gpt-4o");
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
}

// ─── Inject confidence markers into structured items ──────────────────────────
function injectMarkersIntoStructured(structuredSections, confidenceFlags) {
  let matched = 0;

  for (const flag of confidenceFlags) {
    const sec = structuredSections[flag.section];
    if (!sec || !sec.items || !flag.quote) continue;

    const marker = ` [[CF:${flag.type}:${flag.note}]]`;

    function tryInsert(text) {
      if (!text) return null;
      // Try 1: exact match
      const idx = text.indexOf(flag.quote);
      if (idx !== -1) {
        return text.slice(0, idx + flag.quote.length) + marker + text.slice(idx + flag.quote.length);
      }
      // Try 2: normalize whitespace
      const normText = text.replace(/\s+/g, " ");
      const normQuote = flag.quote.replace(/\s+/g, " ").trim();
      const normIdx = normText.indexOf(normQuote);
      if (normIdx !== -1) {
        const anchor = normQuote.split(" ").slice(0, 6).join(" ");
        const anchorIdx = text.indexOf(anchor);
        if (anchorIdx !== -1) {
          return text.slice(0, anchorIdx + anchor.length) + marker + text.slice(anchorIdx + anchor.length);
        }
      }
      // Try 3: first 5 words as anchor
      const shortAnchor = flag.quote.trim().split(/\s+/).slice(0, 5).join(" ");
      if (shortAnchor.length > 15) {
        const shortIdx = text.indexOf(shortAnchor);
        if (shortIdx !== -1) {
          return text.slice(0, shortIdx + shortAnchor.length) + marker + text.slice(shortIdx + shortAnchor.length);
        }
      }
      return null;
    }

    let found = false;
    outer:
    for (const item of sec.items) {
      // Special block text field
      if (item.text) {
        const result = tryInsert(item.text);
        if (result) { item.text = result; found = true; break outer; }
      }
      // Numbered item body blocks
      for (const block of item.body || []) {
        if (block.text) {
          const result = tryInsert(block.text);
          if (result) { block.text = result; found = true; break outer; }
        }
      }
    }
    if (found) matched++;
  }

  return matched;
}

// ─── Detect ownership from structured s1 items ───────────────────────────────
function detectOwnership(items) {
  const text = (items || [])
    .flatMap(item => {
      const texts = [];
      if (item.text) texts.push(item.text);
      for (const block of item.body || []) {
        if (block.text) texts.push(block.text);
      }
      return texts;
    })
    .join(" ")
    .toLowerCase();

  if (/nasdaq|nyse|publicly traded|stock exchange|lse listed|bse listed|nse listed/.test(text)) return "Public Company";
  if (/private equity|pe.backed|pe backed|backed by|portfolio company/.test(text)) return "PE-Backed";
  if (/privately held|private company|family.owned|family owned/.test(text)) return "Private Company";
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📊 Generating content for: ${company}`);
  const p = prompts(company);
  const sections = {};
  const allSources = [];

  const sectionList = [
    { key: "s1", label: "Company Snapshot" },
    { key: "s2", label: "Strategic Direction" },
    { key: "s3", label: "Leadership & Org" },
    { key: "s4", label: "Buying Signals" },
    { key: "s5", label: "Competitive & Vendors" },
  ];
  const sectionLabelMap = Object.fromEntries(sectionList.map(s => [s.key, s.label]));

  // ── Step 1: Gemini research ──────────────────────────────────────────────────
  for (const { key, label } of sectionList) {
    process.stdout.write(`⏳ [Web Scraping Agent] ${label}...`);
    const result = await research(p[key], label);
    sections[key] = result;
    if (result.sources.length) {
      allSources.push(...result.sources.map(s => ({ ...s, section: label })));
    }
    console.log(` ✅ (${result.sources.length} sources)`);
  }

  // ── Step 2: Claude gap check ─────────────────────────────────────────────────
  process.stdout.write(`🔍 [Synthesizing Agent] Checking for gaps...`);
  const gaps = await checkGaps(company, sections);
  console.log(` ✅ (${gaps.length} gaps found)`);

  // ── Step 3: Fill gaps ────────────────────────────────────────────────────────
  if (gaps.length > 0) {
    for (const gap of gaps) {
      process.stdout.write(`⏳ [Web Scraping Agent] Filling gap: ${gap.gap.slice(0, 50)}...`);
      const fillResult = await fillGap(gap);
      sections[gap.section].text += `\n\n[GAP FILL] ${fillResult.text}`;
      if (fillResult.sources.length) {
        allSources.push(...fillResult.sources.map(s => ({
          ...s,
          section: (sectionLabelMap[gap.section] || gap.section) + " (gap fill)"
        })));
      }
      console.log(` ✅`);
    }
  }

  // ── Step 4: Claude Sales Play (structured JSON) ──────────────────────────────
  process.stdout.write(`🧠 [Synthesizing Agent] Building Sales Play...`);
  let salesPlay = null;
  try {
    salesPlay = await synthesizeSalesPlay(company, sections);
    console.log(` ✅`);
  } catch (e) {
    console.log(` ⚠️  Failed: ${e.message.slice(0, 60)} — using fallback`);
    salesPlay = {
      pitch: { title: "To be determined", body: "Sales play generation failed — please re-run." },
      openers: [], landmines: [],
      nextStep: "",
      entry: { name: "", role: "", text: "" }
    };
  }

  // ── Step 4.5: Leadership departure verification ──────────────────────────────
  process.stdout.write(`🔍 [Web Scraping Agent] Verifying leadership departures...`);
  try {
    const verif = await verifyLeadershipDepartures(company, sections.s3.text);
    sections.s3.text += `\n\n[LEADERSHIP VERIFICATION] ${verif.text.slice(0, 1200)}`;
    if (verif.sources.length) {
      allSources.push(...verif.sources.map(s => ({ ...s, section: "Leadership & Org" })));
    }
    console.log(` ✅`);
  } catch (e) {
    console.log(` ⚠️  Skipped: ${e.message.slice(0, 50)}`);
  }

  // ── Step 4.6: Format Agent — structured typed-items JSON ─────────────────────
  process.stdout.write(`✨ [Format Agent] Structuring sections into typed JSON...`);
  let structuredSections = null;
  try {
    structuredSections = await formatSectionsStructured(sections);
    console.log(` ✅`);
  } catch (e) {
    console.log(` ⚠️  Failed (${e.message.slice(0, 60)}) — using minimal fallback`);
    // Fallback: wrap raw text in a single text block per section
    structuredSections = {};
    for (const k of ["s1", "s2", "s3", "s4", "s5"]) {
      structuredSections[k] = {
        items: [{ num: 1, label: sectionLabelMap[k].toUpperCase(), body: [
          { type: "text", text: sections[k]?.text || "" }
        ]}],
        ...(k === "s3" ? { people: [] } : {})
      };
    }
  }

  // Ensure s3 always has a people array
  if (structuredSections.s3 && !structuredSections.s3.people) {
    structuredSections.s3.people = [];
  }

  // ── Step 5: GPT-4o confidence audit ─────────────────────────────────────────
  let confidenceFlags = [];
  if (process.env.OPENAI_API_KEY) {
    process.stdout.write(`🔍 [Audit Agent] Confidence check (GPT-4o)...`);
    try {
      confidenceFlags = await auditConfidence(company, structuredSections);
      const matched = injectMarkersIntoStructured(structuredSections, confidenceFlags);
      console.log(` ✅ (${confidenceFlags.length} flagged, ${matched} matched in text)`);
    } catch (e) {
      console.log(` ⚠️  Audit skipped: ${e.message.slice(0, 60)}`);
    }
  } else {
    console.log(`ℹ️  OPENAI_API_KEY not set — confidence audit skipped`);
  }

  // ── Step 6: Deduplicate sources ──────────────────────────────────────────────
  const seen = new Set();
  const uniqueSources = allSources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // ── Assemble and write content.json ─────────────────────────────────────────
  const content = {
    company,
    slug,
    generatedAt: new Date().toISOString(),
    ownership: detectOwnership(structuredSections.s1?.items),
    sections: {
      s1: { label: "Company Snapshot",     ...structuredSections.s1 },
      s2: { label: "Strategic Direction",  ...structuredSections.s2 },
      s3: { label: "Leadership & Org",     ...structuredSections.s3 },
      s4: { label: "Buying Signals",       ...structuredSections.s4 },
      s5: { label: "Competitive & Vendors",...structuredSections.s5 },
      s6: { label: "Sales Play",           salesPlay }
    },
    sources: uniqueSources,
    confidenceFlags
  };

  if (!fs.existsSync("reports")) fs.mkdirSync("reports");
  const contentPath = path.join("reports", `${slug}.content.json`);
  fs.writeFileSync(contentPath, JSON.stringify(content, null, 2));
  console.log(`\n✅ Content saved: ${contentPath} (${uniqueSources.length} sources)`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
