require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require("https");
const fs = require("fs");
const path = require("path");

const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const company = process.env.COMPANY || process.argv[2];

if (!company) {
  console.error("Usage: COMPANY=\'IKEA\' node generate.js");
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
        console.log(`\n⚠️  Rate limit on ${label}. Retrying in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else { throw err; }
    }
  }
}

// ─── Gemini research (returns text + sources) ─────────────────────────────────
async function research(prompt, label, isRetryForRecitation = false) {
  // On recitation retry, prepend instruction to paraphrase instead of quote
  const finalPrompt = isRetryForRecitation
    ? "IMPORTANT: Do NOT reproduce any text verbatim. Paraphrase all information in your own words.\n\n" + prompt
    : prompt;

  const attemptFn = async () => {
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(finalPrompt);

    // Check for RECITATION block before calling .text()
    const candidates = result.response.candidates || [];
    if (candidates.length > 0) {
      const finishReason = candidates[0].finishReason;
      if (finishReason === "RECITATION") {
        throw new Error("RECITATION_BLOCK");
      }
    }

    const text = result.response.text();

    // Extract sources from grounding metadata
    const sources = [];
    try {
      const meta = candidates[0]?.groundingMetadata;
      const chunks = meta?.groundingChunks || [];
      chunks.forEach(chunk => {
        if (chunk.web?.uri) {
          sources.push({ url: chunk.web.uri, title: chunk.web.title || chunk.web.uri });
        }
      });
    } catch(e) { /* sources unavailable */ }

    return { text, sources };
  };

  try {
    return await withRetry(attemptFn, label);
  } catch(err) {
    // On RECITATION, retry once with paraphrase instruction
    if (err.message === "RECITATION_BLOCK" && !isRetryForRecitation) {
      console.log(`\n⚠️  RECITATION block on ${label}. Retrying with paraphrase mode...`);
      return research(prompt, label, true);
    }
    // If still failing after retry, return a fallback so the run doesn't crash
    if (err.message === "RECITATION_BLOCK") {
      console.log(`\n⚠️  RECITATION block persisted on ${label}. Using fallback.`);
      return { text: `Data for this section could not be retrieved (content filter). Please research ${label} manually.`, sources: [] };
    }
    throw err;
  }
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

// ─── Claude API call helper ───────────────────────────────────────────────────
function claudeCall(prompt, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
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

// ─── Claude gap checker ───────────────────────────────────────────────────────
async function checkGaps(c, sections) {
  const sectionSummary = Object.entries(sections).map(([k, v]) =>
    `${k.toUpperCase()}: ${v.text.slice(0, 800)}`
  ).join("\n\n");

  const prompt = `You are a senior sales researcher reviewing research on "${c}".

Review the sections below and identify SPECIFIC data gaps — missing numbers, unknown executives, vague tech stack info, missing financials etc.

Return ONLY a JSON array. Each item has:
- "section": one of "s1","s2","s3","s4","s5"
- "gap": one sentence describing what is missing
- "query": a specific Google search query to fill that gap (5-10 words max)

Return maximum 5 gaps total. Only flag genuinely missing data, not minor gaps. If data is sufficient, return empty array [].

SECTIONS:
${sectionSummary}

Return ONLY valid JSON. No explanation. No markdown.`;

  const raw = await claudeCall(prompt, 1000);
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch(e) {
    console.log("  Gap check parse failed, skipping gap fill");
    return [];
  }
}

// ─── Targeted gap fill ────────────────────────────────────────────────────────
async function fillGap(gap, label) {
  const prompt = `You are a senior sales researcher. Search for this specific information and return ONLY the relevant data. No intro sentence.

Query: ${gap.query}

Return only the specific data found. Be concise. 3-5 lines max.`;

  const result = await research(prompt, label);
  return result;
}

// ─── Claude synthesis ─────────────────────────────────────────────────────────
async function synthesize(c, sections) {
  const context = Object.entries(sections).map(([k,v]) =>
    `SECTION ${k.toUpperCase()}:\n${v.text}`
  ).join("\n\n");

  const prompt = `You are an expert B2B sales strategist. Based on research below, generate Section 6 of a pre-sales intelligence brief. Use plain text only. No markdown.

${context}

SECTION 6 — SALES PLAY & CONVERSATION STARTERS:

1. RECOMMENDED PITCH ANGLE: Single strongest hook. (Cost / Transformation / GTM / Compliance / AI play). Explain WHY in 3-4 lines citing specific findings above.

2. CONVERSATION OPENER QUESTIONS: 4-5 specific, informed questions referencing real things happening at the company.

3. LANDMINES TO AVOID: 3-4 specific topics that could kill the conversation. Be direct.

4. SUGGESTED NEXT STEP: Most logical first meeting ask. Be specific.

5. BEST ENTRY POINT: Single most likely first contact. Name the role and person. Complete your answer fully.`;

  return claudeCall(prompt, 3000);
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
    if (!trimmed) { i++; continue; }
    // Markdown table block
    if (trimmed.startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tableLines.push(lines[i]); i++; }
      html += parseTable(tableLines);
      continue;
    }
    // Numbered section header — flexible pattern catches "(Last 6 months...)" variants
    const numMatch = trimmed.match(/^(\d+)\.\s+([A-Z][A-Z\s&\/()]+?)(?::|\s*\()/);
    if (numMatch) {
      const label = numMatch[2].trim();
      let bodyLines = [];
      // Capture rest of same line after colon if present
      const colonIdx = trimmed.indexOf(":", numMatch[0].length - 1);
      if (colonIdx !== -1) bodyLines.push(trimmed.slice(colonIdx + 1).trim());
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next) { i++; break; }
        if (/^\d+\.\s+[A-Z]/.test(next)) break;
        bodyLines.push(next);
        i++;
      }
      let bodyHtml = "";
      let j = 0;
      while (j < bodyLines.length) {
        const bl = bodyLines[j];
        if (!bl) { j++; continue; }
        if (bl.startsWith("|")) {
          const tbl = [];
          while (j < bodyLines.length && bodyLines[j].startsWith("|")) { tbl.push(bodyLines[j]); j++; }
          bodyHtml += parseTable(tbl);
        } else if (/^[*•\-]\s+/.test(bl)) {
          bodyHtml += `<div class="content-bullet"><span class="bullet-dot"></span><span>${bl.replace(/^[*•\-]\s+/, "")}</span></div>`;
          j++;
        } else {
          bodyHtml += `<div class="content-text">${bl}</div>`;
          j++;
        }
      }
      html += `<div class="content-item"><div class="content-num">${numMatch[1]}</div><div class="content-body"><div class="content-label">${label}</div>${bodyHtml}</div></div>`;
      continue;
    }
    // Bullet items
    if (/^[*•\-]\s+/.test(trimmed)) {
      html += `<div class="content-bullet"><span class="bullet-dot"></span><span>${trimmed.replace(/^[*•\-]\s+/, "")}</span></div>`;
      i++; continue;
    }
    // Regular text
    html += `<div class="content-text">${trimmed}</div>`;
    i++;
  }
  return html;
}

// ─── Build HTML report ────────────────────────────────────────────────────────
function buildHTML(company, sections, sources = []) {
  const generated = new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" });
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");

  const sectionDefs = [
    { key: "s1", id: "snapshot",   label: "Company Snapshot",    icon: "🏢" },
    { key: "s2", id: "strategy",   label: "Strategic Direction",  icon: "🎯" },
    { key: "s3", id: "leadership", label: "Leadership & Org",     icon: "👥" },
    { key: "s4", id: "signals",    label: "Buying Signals",       icon: "📡" },
    { key: "s5", id: "vendors",    label: "Competitive & Vendors",icon: "🔍" },
    { key: "s6", id: "salesplay",  label: "Sales Play",           icon: "⚡" },
  ];

  const navPills = sectionDefs.map(s => `<a href="#${s.id}">${s.icon} ${s.label}</a>`).join("");
  const sectionCards = sectionDefs.map(s => `
    <div class="section" id="${s.id}">
      <div class="section-hdr">${s.icon} ${s.label}</div>
      <div class="card"><div class="card-body">${formatContent(clean(sections[s.key] || ""))}</div></div>
    </div>`).join("");

  // Build collapsible sources panel
  let sourcesPanel = "";
  if (sources.length > 0) {
    const grouped = {};
    sources.forEach(s => {
      const sec = s.section || "General";
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push(s);
    });
    let srcHtml = "";
    Object.entries(grouped).forEach(([sec, srcs]) => {
      srcHtml += `<div class="src-group"><div class="src-group-label">${sec}</div>`;
      srcs.forEach(s => {
        srcHtml += `<a class="src-link" href="${s.url}" target="_blank" rel="noopener">${s.title}</a>`;
      });
      srcHtml += `</div>`;
    });
    sourcesPanel = `
<div class="sources-panel">
  <button class="sources-toggle" onclick="this.parentElement.classList.toggle('open')">
    📎 Sources & References (${sources.length}) <span class="src-chevron">▼</span>
  </button>
  <div class="sources-body">${srcHtml}</div>
</div>`;
  }

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
.sec-nav { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 10px; scrollbar-width: none; }
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
.hero { background: linear-gradient(135deg, var(--navy) 0%, #2E74B5 100%); padding: 24px 16px 20px; }
.hero-label { color: var(--vblue); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
.hero-company { color: #fff; font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.hero-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.hero-badge { background: rgba(255,255,255,.12); color: #fff; font-size: 10px; font-weight: 600; padding: 4px 12px; border-radius: 20px; }

/* PDF Banner */
.pdf-banner { background: var(--lblue); border-bottom: 1px solid #C4DCF0; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; }
.pdf-banner-text { font-size: 12px; color: var(--navy); font-weight: 500; }
.pdf-btn { background: var(--navy); color: #fff; font-size: 11px; font-weight: 600; padding: 7px 16px; border-radius: 20px; text-decoration: none; }

/* Sections */
.section { padding: 20px 14px 0; }
.section-hdr { font-size: 11px; font-weight: 700; color: var(--navy); letter-spacing: .1em; text-transform: uppercase; margin-bottom: 10px; }
.card { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 12px; }
.card-body { padding: 0; overflow: hidden; }

/* Content items */
.content-item { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 0.5px solid var(--border); min-width: 0; }
.content-item:last-child { border-bottom: none; }
.content-num {
  flex-shrink: 0; width: 24px; height: 24px;
  background: var(--navy); color: #fff; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; margin-top: 2px;
}
.content-body { flex: 1; min-width: 0; overflow-wrap: break-word; word-break: break-word; }
.content-label { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.content-text { font-size: 13px; color: var(--t2); line-height: 1.65; margin-bottom: 4px; word-wrap: break-word; }
.content-text:last-child { margin-bottom: 0; }

/* Bullets */
.content-bullet { display: flex; gap: 10px; padding: 3px 0; }
.bullet-dot { flex-shrink: 0; width: 5px; height: 5px; background: var(--blue); border-radius: 50%; margin-top: 8px; }
.content-bullet > span:last-child { font-size: 12.5px; color: var(--t2); line-height: 1.6; }

/* Tables */
.tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 6px 0; }
.data-table { border-collapse: collapse; width: 100%; font-size: 12px; min-width: 300px; }
.data-table th { background: var(--navy); color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; font-weight: 600; white-space: nowrap; }
.data-table td { padding: 8px 10px; border-bottom: 0.5px solid var(--border); color: var(--t2); vertical-align: top; line-height: 1.5; }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:nth-child(even) td { background: #FAFBFC; }

/* Sales play special */
#salesplay .card { border-top: 3px solid var(--blue); }
.sp-pitch { background: #EBF3FB; border-left: 3px solid var(--blue); padding: 12px 14px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.sp-pitch-tag { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
.sp-pitch-text { font-size: 13px; color: var(--t1); line-height: 1.65; }
.sp-landmine { background: #FFF8EC; border-left: 3px solid var(--amber); padding: 10px 14px; border-radius: 0 6px 6px 0; margin-bottom: 8px; }
.sp-landmine-title { font-size: 12px; font-weight: 700; color: #92600A; margin-bottom: 3px; }
.sp-landmine-text { font-size: 12px; color: #78350F; line-height: 1.6; }
.sp-entry { background: #F0FDF4; border-left: 3px solid #16a34a; padding: 12px 14px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.sp-entry-name { font-size: 15px; font-weight: 700; color: #166534; margin-bottom: 2px; }
.sp-entry-role { font-size: 11px; font-weight: 600; color: #16a34a; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
.sp-entry-text { font-size: 12.5px; color: #166534; line-height: 1.6; text-transform: none; }
.sp-nextstep { background: #F8F9FA; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 6px 0; font-size: 13px; color: var(--t2); line-height: 1.65; }

/* Footer */
.report-footer { margin: 24px 14px 8px; padding: 16px; background: var(--card); border-radius: var(--radius); border-top: 2px solid var(--navy); }
.footer-disclaimer { font-size: 11px; color: var(--t3); line-height: 1.7; }
.footer-meta { font-size: 10px; color: var(--t3); text-align: center; font-style: italic; margin-top: 8px; }

@media print {
  .top-bar { position: relative; }
  .sec-nav { display: none; }
  body { padding-bottom: 0; }
  .section { padding: 12px 10px 0; }
  .card { break-inside: avoid; }
}

/* Hide orphan intro text that floats outside numbered items */
.card-body > .content-text:first-child { 
  padding: 12px 16px 0; 
  font-size: 12px; 
  color: var(--t3); 
  font-style: italic; 
}
/* Ensure bullets inside content-body have proper padding */
.content-body .content-bullet { padding: 2px 0; }
/* Prevent text overflow in table cells */
.data-table td, .data-table th { word-break: break-word; max-width: 200px; }

/* Sources panel */
.sources-panel { margin: 0 14px 24px; border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.sources-toggle { width: 100%; background: var(--navy); color: #fff; border: none; padding: 12px 16px; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.src-chevron { transition: transform .2s; }
.sources-panel.open .src-chevron { transform: rotate(180deg); }
.sources-body { display: none; background: var(--card); padding: 12px 16px; }
.sources-panel.open .sources-body { display: block; }
.src-group { margin-bottom: 12px; }
.src-group:last-child { margin-bottom: 0; }
.src-group-label { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.src-link { display: block; font-size: 11px; color: var(--t2); text-decoration: none; padding: 4px 0; border-bottom: 0.5px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-link:last-child { border-bottom: none; }
.src-link:hover { color: var(--blue); }
</style>
</head>
<body>

<div class="top-bar">
  <div class="top-bar-row">
    <div>
      <div class="top-brand">ITC Infotech</div>
      <div class="top-sub">Account Intelligence · Internal · Sales Only</div>
    </div>
    <div class="top-date">${generated}</div>
  </div>
  <div class="sec-nav">${navPills}</div>
</div>

<div class="hero">
  <div class="hero-label">Pre-Sales Intelligence Brief</div>
  <div class="hero-company">${company}</div>
  <div class="hero-meta">
    <span class="hero-badge">📅 ${generated}</span>
    <span class="hero-badge" id="ownership-badge">⚠️ Verify before use</span>
  </div>
</div>

<div class="pdf-banner">
  <div class="pdf-banner-text">📄 Download full report as PDF</div>
  <a class="pdf-btn" href="${slug}.pdf" download>Download PDF →</a>
</div>

${sectionCards}

<div class="report-footer">
  <div class="footer-disclaimer">This report was generated with AI assistance. Data is sourced from publicly available information including company websites, press releases, earnings calls, and news sources. AI tools can introduce errors. Cross-check any data point you intend to act on. Do not share outside ITC Infotech.</div>
  <div class="footer-meta">ITC Infotech · Account Intelligence Engine v0.1 · ${generated}</div>
</div>

<!-- SOURCES PANEL -->
${sourcesPanel}

<script>
(function() {
  var cardBodies = document.querySelectorAll('.card-body');
  cardBodies.forEach(function(cb) {
    var children = Array.from(cb.children);
    
    // Find all content-text children that look like numbered headers
    var hasNumberedText = children.some(function(el) {
      return el.classList.contains('content-text') && /^\d+\.\s+[A-Z]/.test(el.textContent.trim());
    });
    if (!hasNumberedText) return;

    // Group all children into blocks: each block starts at a numbered header
    var blocks = [];
    var currentBlock = null;
    var preItems = []; // items before first numbered header

    children.forEach(function(el) {
      var text = el.textContent.trim();
      var isNumHeader = el.classList.contains('content-text') && /^\d+\.\s+[A-Z]/.test(text);
      var isExistingItem = el.classList.contains('content-item');

      if (isNumHeader) {
        if (currentBlock) blocks.push(currentBlock);
        var match = text.match(/^(\d+)\.\s+([^:(]+)/);
        var num = match ? match[1] : '';
        var label = match ? match[2].trim() : text;
        currentBlock = { num: num, label: label, children: [], el: el };
      } else if (isExistingItem) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
        blocks.push({ existing: el });
      } else {
        if (currentBlock) {
          currentBlock.children.push(el);
        } else {
          preItems.push(el);
        }
      }
    });
    if (currentBlock) blocks.push(currentBlock);

    if (blocks.length === 0) return;

    // Rebuild card body
    cb.innerHTML = '';

    // Add pre-items as hidden (intro text)
    preItems.forEach(function(el) {
      el.style.display = 'none';
      cb.appendChild(el);
    });

    blocks.forEach(function(block) {
      if (block.existing) {
        cb.appendChild(block.existing);
        return;
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'content-item';
      var bodyHtml = '<div class="content-body"><div class="content-label">' + block.label + '</div>';
      wrapper.innerHTML = '<div class="content-num">' + block.num + '</div>' + bodyHtml + '</div>';
      var bodyEl = wrapper.querySelector('.content-body');
      block.children.forEach(function(child) {
        bodyEl.appendChild(child.cloneNode(true));
      });
      cb.appendChild(wrapper);
    });
  });
})();

(function() {
  var cardBodies = document.querySelectorAll('.card-body');
  cardBodies.forEach(function(cb) {
    var hasItem = cb.querySelector('.content-item');
    if (!hasItem) return;

    // Repeatedly scan until no more orphans exist
    var changed = true;
    var safety = 0;
    while (changed && safety < 20) {
      changed = false;
      safety++;
      var children = Array.from(cb.childNodes).filter(function(n) {
        return n.nodeType === 1; // element nodes only
      });

      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        var isOrphan = (el.classList.contains('content-text') || el.classList.contains('content-bullet'));
        if (!isOrphan) continue;

        // Find the previous content-item sibling
        var prevItem = null;
        for (var j = i - 1; j >= 0; j--) {
          if (children[j].classList.contains('content-item')) {
            prevItem = children[j];
            break;
          }
        }

        if (prevItem) {
          var body = prevItem.querySelector('.content-body');
          if (body) {
            body.appendChild(el);
            changed = true;
            break; // restart loop after DOM mutation
          }
        } else {
          // No preceding content-item — just hide it
          el.style.display = 'none';
          changed = true;
          break;
        }
      }
    }
  });
})();

(function() {
  // Fix Section 6 Sales Play formatting
  var salesplay = document.querySelector('#salesplay .card-body');
  if (salesplay) {
    var rawText = salesplay.innerText || '';
    if (rawText.indexOf('RECOMMENDED PITCH ANGLE') !== -1) {
      function extractBlock(text, startMarker, endMarkers) {
        var start = text.indexOf(startMarker);
        if (start === -1) return '';
        var end = text.length;
        for (var i = 0; i < endMarkers.length; i++) {
          var pos = text.indexOf(endMarkers[i], start + startMarker.length);
          if (pos !== -1 && pos < end) end = pos;
        }
        return text.slice(start + startMarker.length, end).trim();
      }

      var M = ['RECOMMENDED PITCH ANGLE','CONVERSATION OPENER QUESTIONS','LANDMINES TO AVOID','SUGGESTED NEXT STEP','BEST ENTRY POINT'];
      var pitch    = extractBlock(rawText, M[0], M.slice(1));
      var openers  = extractBlock(rawText, M[1], M.slice(2));
      var landmine = extractBlock(rawText, M[2], M.slice(3));
      var nextstep = extractBlock(rawText, M[3], M.slice(4));
      var entry    = extractBlock(rawText, M[4], []);

      // Pitch - first line is play type, rest is body
      var pitchLines = pitch.split('\n').map(function(l){return l.trim();}).filter(function(l){return l.length>0;});
      var pitchTitle = pitchLines.length > 0 ? pitchLines[0] : '';
      var pitchBody  = pitchLines.slice(1).join(' ') || pitchTitle;

      // Openers - each non-empty line is a question
      var openerLines = openers.split('\n').map(function(l){
        return l.trim().replace(/^Question\s*\d+:\s*/i,'');
      }).filter(function(l){return l.length > 20;});

      // Landmines - paragraph blocks
      var lmParas = landmine.split('\n\n').map(function(p){return p.replace(/\n/g,' ').trim();}).filter(function(p){return p.length>0;});
      if (lmParas.length === 1) {
        lmParas = landmine.split('\n').filter(function(l){return l.trim().length > 0;});
      }

      // Entry point - split by paragraph, skip uppercase blocks
      var entryParas = entry.split('\n\n').map(function(p){return p.trim();}).filter(function(p){return p.length>0;});
      // If no double newlines, try single
      if (entryParas.length <= 1) {
        entryParas = entry.split('\n').map(function(p){return p.trim();}).filter(function(p){return p.length>0;});
      }
      // Filter out paragraphs where >65% of letters are uppercase (raw artifact)
      function isUpperCase(str) {
        var letters = str.replace(/[^A-Za-z]/g,'');
        if (letters.length < 10) return false;
        var upCount = letters.split('').filter(function(c){return c===c.toUpperCase()&&c!==c.toLowerCase();}).length;
        return (upCount / letters.length) > 0.65;
      }
      var entryClean = entryParas.filter(function(p){ return !isUpperCase(p); });
      // Fallback to all paras if filter removed everything
      if (entryClean.length === 0) entryClean = entryParas;
      var entryName = entryClean.length > 0 ? entryClean[0] : '';
      var entryRole = entryClean.length > 1 ? entryClean[1] : '';
      var entryText = entryClean.slice(2).join(' ') || entryClean.slice(1).join(' ');

      // Build HTML
      var html = '';

      // 1. Pitch angle
      html += '<div class="content-item"><div class="content-num">1</div><div class="content-body">';
      html += '<div class="content-label">Recommended Pitch Angle</div>';
      html += '<div class="sp-pitch"><div class="sp-pitch-tag">' + pitchTitle + '</div>';
      html += '<div class="sp-pitch-text">' + pitchBody + '</div></div>';
      html += '</div></div>';

      // 2. Openers
      html += '<div class="content-item"><div class="content-num">2</div><div class="content-body">';
      html += '<div class="content-label">Conversation Opener Questions</div>';
      openerLines.forEach(function(q) {
        html += '<div class="content-bullet"><span class="bullet-dot"></span><span>' + q + '</span></div>';
      });
      html += '</div></div>';

      // 3. Landmines
      html += '<div class="content-item"><div class="content-num">3</div><div class="content-body">';
      html += '<div class="content-label">Landmines to Avoid</div>';
      lmParas.forEach(function(lm) {
        var parts = lm.match(/^([^:]{5,60}):\s*(.*)/);
        if (parts) {
          html += '<div class="sp-landmine"><div class="sp-landmine-title">&#9888;&#65039; ' + parts[1] + '</div><div class="sp-landmine-text">' + parts[2] + '</div></div>';
        } else {
          html += '<div class="sp-landmine"><div class="sp-landmine-text">' + lm + '</div></div>';
        }
      });
      html += '</div></div>';

      // 4. Next step
      html += '<div class="content-item"><div class="content-num">4</div><div class="content-body">';
      html += '<div class="content-label">Suggested Next Step</div>';
      html += '<div class="sp-nextstep">' + nextstep + '</div>';
      html += '</div></div>';

      // 5. Entry point
      html += '<div class="content-item"><div class="content-num">5</div><div class="content-body">';
      html += '<div class="content-label">Best Entry Point</div>';
      html += '<div class="sp-entry"><div class="sp-entry-name">' + entryName + '</div>';
      html += '<div class="sp-entry-role">' + entryRole + '</div>';
      html += '<div class="sp-entry-text">' + entryText + '</div></div>';
      html += '</div></div>';

      salesplay.innerHTML = html;
    }
  }

  // Ownership badge
  var s1 = document.querySelector('#snapshot .card-body');
  var badge = document.getElementById('ownership-badge');
  if (s1 && badge) {
    var t = (s1.innerText || '').toLowerCase();
    if (t.indexOf('nasdaq') !== -1 || t.indexOf('nyse') !== -1 || t.indexOf('publicly traded') !== -1) {
      badge.textContent = 'Public Company';
    } else if (t.indexOf('private equity') !== -1 || t.indexOf('pe-backed') !== -1) {
      badge.textContent = 'PE-Backed';
    } else if (t.indexOf('privately held') !== -1 || t.indexOf('private company') !== -1 || t.indexOf('family-owned') !== -1) {
      badge.textContent = 'Private Company';
    }
  }
})();

(function() {
  function runLeadershipFix() {
    var leadership = document.querySelector('#leadership .card-body');
    if (!leadership) return;
    var items = leadership.querySelectorAll('.content-item');
    items.forEach(function(item) {
      var label = item.querySelector('.content-label');
      if (!label || label.textContent.trim() !== 'KEY DECISION MAKERS') return;
      var body = item.querySelector('.content-body');
      if (!body) return;

      // Collect all text lines from bullets AND content-text inside body
      var lines = [];
      Array.from(body.children).forEach(function(child) {
        if (child.classList.contains('content-bullet')) {
          var span = child.querySelector('span:last-child');
          if (span) lines.push(span.textContent.trim());
        } else if (child.classList.contains('content-text')) {
          var t = child.textContent.trim();
          if (t) lines.push(t);
        }
      });

      if (lines.length === 0) return;

      var personGroups = [];
      var current = null;
      lines.forEach(function(line) {
        var isNewPerson = /^(CEO|CFO|CTO|COO|Chief|Executive Vice President|President|Global Chief)/i.test(line);
        if (isNewPerson) {
          if (current) personGroups.push(current);
          var colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            current = { role: line.slice(0, colonIdx).trim(), name: line.slice(colonIdx+1).trim(), tenure: '', background: '', details: [] };
          } else {
            current = { role: line, name: '', tenure: '', background: '', details: [] };
          }
        } else if (current) {
          if (/^Tenure:/i.test(line)) {
            current.tenure = line.replace(/^Tenure:\s*/i, '');
          } else if (/^Background:/i.test(line)) {
            current.background = line.replace(/^Background:\s*/i, '');
          } else {
            current.details.push(line);
          }
        }
      });
      if (current) personGroups.push(current);
      if (personGroups.length === 0) return;

      var html = '<div class="content-label" style="margin-bottom:10px;">KEY DECISION MAKERS</div>';
      personGroups.forEach(function(p) {
        html += '<div style="background:#F8F9FA;border-radius:8px;padding:12px 14px;margin-bottom:10px;border-left:3px solid var(--blue);">';
        if (p.name) {
          html += '<div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:2px;">' + p.name.trim() + '</div>';
        }
        html += '<div style="font-size:11px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">' + p.role + '</div>';
        if (p.tenure) {
          html += '<div style="font-size:11px;color:var(--t3);margin-bottom:5px;">In role: ' + p.tenure + '</div>';
        }
        if (p.background) {
          html += '<div style="font-size:12.5px;color:var(--t2);line-height:1.6;">' + p.background + '</div>';
        }
        p.details.forEach(function(d) {
          html += '<div style="font-size:12px;color:var(--t2);margin-top:4px;padding-left:8px;border-left:2px solid var(--border);">' + d + '</div>';
        });
        html += '</div>';
      });
      body.innerHTML = html;
    });
  }
  // Run after a short delay to ensure orphan fix has completed
  setTimeout(runLeadershipFix, 50);
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
  const allSources = [];

  // ── Step 1: Gemini research ──────────────────────────────────────────────────
  const sectionList = [
    { key: "s1", label: "Company Snapshot" },
    { key: "s2", label: "Strategic Direction" },
    { key: "s3", label: "Leadership & Org" },
    { key: "s4", label: "Buying Signals" },
    { key: "s5", label: "Competitive & Vendors" },
  ];

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
      const fillResult = await fillGap(gap, gap.gap);
      // Append to existing section
      sections[gap.section].text += `\n\n[GAP FILL] ${fillResult.text}`;
      if (fillResult.sources.length) {
        allSources.push(...fillResult.sources.map(s => ({
          ...s,
          section: gap.section + " (gap fill)"
        })));
      }
      console.log(` ✅`);
    }
  }

  // ── Step 4: Claude synthesis ─────────────────────────────────────────────────
  process.stdout.write(`🧠 [Synthesizing Agent] Building Sales Play...`);
  const s6text = await synthesize(company, sections);
  sections.s6 = { text: s6text, sources: [] };
  console.log(` ✅`);

  // ── Step 5: Deduplicate sources ──────────────────────────────────────────────
  const seen = new Set();
  const uniqueSources = allSources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // ── Step 6: Build HTML ───────────────────────────────────────────────────────
  const html = buildHTML(company, sections, uniqueSources);
  if (!fs.existsSync("reports")) fs.mkdirSync("reports");
  const outPath = path.join("reports", `${slug}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`\n✅ Report saved: ${outPath} (${uniqueSources.length} sources)`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});