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

CRITICAL INSTRUCTION: For every executive you list, you MUST verify they are STILL in their current role as of today. Search specifically for "${c} executive departure OR left OR resigned OR stepped down 2024 2025 2026" before listing anyone. If you find evidence someone has departed, DO NOT list them as current — instead note their departure explicitly. If you cannot confirm someone is still in role from a recent source, say so clearly.

1. KEY DECISION MAKERS: CEO, CFO, CTO/CDO/CIO, COO — full name, start date, brief background (2 lines max). Only list people CONFIRMED still in role.
2. RECENT LEADERSHIP CHANGES: C-suite or VP changes in last 18 months including DEPARTURES. Who left, when, where did they go? Flag all as timing signals.
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

// ─── OpenAI GPT-4o API call (confidence audit) ───────────────────────────────
function gptCall(prompt, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.choices[0].message.content);
        } catch(e) { reject(new Error("GPT parse error: " + data.slice(0, 200))); }
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

// ─── Leadership departure verification (Gemini with Search) ──────────────────
async function verifyLeadershipDepartures(company, s3text) {
  const prompt = `You are verifying current executive status for a sales intelligence brief on "${company}".

Do TWO targeted searches:
1. "${company} executive departed left resigned stepped down 2024 2025 2026"
2. "${company} new CEO CFO CIO COO appointed 2025 2026"

Current leadership in our research:
${s3text.slice(0, 1200)}

Return:
- CONFIRMED DEPARTED: Name, role, departure date, where they went (if known)
- UNCONFIRMED STILL IN ROLE: Name and role where you could not find recent confirmation (within 6 months) they are still there
- CONFIRMED STILL IN ROLE: Name and role with the source/date that confirms it

Be specific. Only report what recent sources confirm. If no departures found, say so explicitly.`;

  return research(prompt, "Leadership Verification");
}

// ─── GPT-4o confidence audit ─────────────────────────────────────────────────
async function auditConfidence(company, sections) {
  const auditSections = ["s1", "s2", "s3", "s4", "s5"];
  const labelMap = { s1: "Company Snapshot", s2: "Strategic Direction", s3: "Leadership & Org", s4: "Buying Signals", s5: "Competitive & Vendors" };

  const sectionBlocks = auditSections
    .filter(k => sections[k] && sections[k].text)
    .map(k => `--- ${k.toUpperCase()} (${labelMap[k]}) ---\n${sections[k].text.slice(0, 1800)}`)
    .join("\n\n");

  const prompt = `You are a senior fact-checker reviewing a B2B sales intelligence brief for ${company}.

Identify specific claims that leadership should treat with caution. Flag claims that are:
- UNVERIFIED: stated as fact but no reliable public source is likely to exist, or the claim is speculative
- INFERRED: derived from indirect evidence only (job postings, LinkedIn, contextual clues) — not directly stated by the company
- ASSUMED: working assumption with no evidence cited
- OUTDATED: data likely stale (more than 18 months old and the situation may have changed)

Return ONLY valid JSON in this exact format:
{"flags": [{"section": "s1", "quote": "exact verbatim phrase", "type": "unverified", "note": "reason in 8 words max"}, ...]}

Rules:
- "quote" must be VERBATIM text copied exactly from the sections below — 8 to 20 words, unique enough to locate
- Maximum 12 flags total. Be selective — only flag claims that genuinely matter for a sales conversation
- Do NOT flag: obvious public facts, known M&A events with press records, company names, widely reported financials
- PRIORITISE flagging: executive backgrounds/tenures not in press releases, financial figures with no cited source, tech stack claims from job postings only, org structure speculation, headcount estimates without source
- If confident data is sufficient, return fewer flags. Return {"flags": []} if nothing needs flagging

SECTIONS:
${sectionBlocks}`;

  const raw = await gptCall(prompt, 2000);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.flags) ? parsed.flags : [];
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

// ─── Inject inline confidence badges ─────────────────────────────────────────
function injectConfidenceBadges(text) {
  return text.replace(/\[\[CF:(\w+):([^\]]*)\]\]/g, (_, type, note) => {
    const labels = { inferred: "Inferred", unverified: "Unverified", assumed: "Assumed", outdated: "Outdated" };
    const safeNote = note.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<span class="cf-badge cf-${type}" title="${safeNote}">${labels[type] || type}</span>`;
  });
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
          bodyHtml += `<div class="content-bullet"><span class="bullet-dot"></span><span>${injectConfidenceBadges(bl.replace(/^[*•\-]\s+/, ""))}</span></div>`;
          j++;
        } else {
          bodyHtml += `<div class="content-text">${injectConfidenceBadges(bl)}</div>`;
          j++;
        }
      }
      html += `<div class="content-item"><div class="content-num">${numMatch[1]}</div><div class="content-body"><div class="content-label">${label}</div>${bodyHtml}</div></div>`;
      continue;
    }
    // Bullet items
    if (/^[*•\-]\s+/.test(trimmed)) {
      html += `<div class="content-bullet"><span class="bullet-dot"></span><span>${injectConfidenceBadges(trimmed.replace(/^[*•\-]\s+/, ""))}</span></div>`;
      i++; continue;
    }
    // [DEPARTED] blocks — red, executive no longer in role
    if (trimmed.startsWith("[DEPARTED")) {
      const bracketEnd = trimmed.indexOf("]");
      const content = bracketEnd !== -1 ? trimmed.slice(bracketEnd + 1).trim() : trimmed.slice(9).trim();
      html += `<div class="departed-block"><span class="departed-tag">⚠ Departed</span><div class="departed-content">${content}</div></div>`;
      i++; continue;
    }
    // [LEADERSHIP VERIFICATION] blocks — blue, verification check result
    if (trimmed.startsWith("[LEADERSHIP VERIFICATION]")) {
      const content = trimmed.slice(25).trim();
      html += `<div class="verify-block"><span class="verify-tag">✓ Leadership Verified</span><div class="verify-content">${content}</div></div>`;
      i++; continue;
    }
    // [GAP FILL] blocks — amber badge with optional qualifier note
    if (trimmed.startsWith("[GAP FILL")) {
      const bracketEnd = trimmed.indexOf("]");
      const inner = bracketEnd > 9 ? trimmed.slice(10, bracketEnd).replace(/^[\s—–-]+/, "").trim() : "";
      const content = bracketEnd !== -1 ? trimmed.slice(bracketEnd + 1).trim() : trimmed.slice(9).trim();
      html += `<div class="gap-fill-block"><span class="gap-fill-tag">Gap Fill</span>${inner ? `<div class="gap-fill-note">${inner}</div>` : ""}<div class="gap-fill-content">${content}</div></div>`;
      i++; continue;
    }
    // Regular text
    html += `<div class="content-text">${injectConfidenceBadges(trimmed)}</div>`;
    i++;
  }
  return html;
}

// ─── Build confidence notes panel ────────────────────────────────────────────
function buildConfPanel(flags) {
  if (!flags || flags.length === 0) return "";
  const sectionLabels = { s1: "Company Snapshot", s2: "Strategic Direction", s3: "Leadership & Org", s4: "Buying Signals", s5: "Competitive & Vendors" };
  const typeLabels = { inferred: "Inferred", unverified: "Unverified", assumed: "Assumed", outdated: "Outdated" };
  const items = flags.map(f => `
    <div class="conf-item">
      <div class="conf-item-left"><span class="cf-badge cf-${f.type}">${typeLabels[f.type] || f.type}</span></div>
      <div class="conf-item-right">
        <div class="conf-item-section">${sectionLabels[f.section] || f.section}</div>
        <div class="conf-item-quote">"${f.quote}"</div>
        <div class="conf-item-note">${f.note}</div>
      </div>
    </div>`).join("");
  return `
<div class="conf-panel">
  <button class="conf-toggle" onclick="this.parentElement.classList.toggle('open')">
    ⚠️ Confidence Notes — ${flags.length} item${flags.length !== 1 ? "s" : ""} flagged for leadership review <span class="conf-chevron">▼</span>
  </button>
  <div class="conf-body">${items}</div>
</div>`;
}

// ─── Build HTML report ────────────────────────────────────────────────────────
function buildHTML(company, sections, sources = [], confidenceFlags = []) {
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

  // Group sources by section label for per-card source strips
  const sourcesBySection = {};
  sources.forEach(s => {
    const label = s.section ? s.section.replace(" (gap fill)", "") : "General";
    if (!sourcesBySection[label]) sourcesBySection[label] = [];
    sourcesBySection[label].push(s);
  });

  const sectionCards = sectionDefs.map(s => {
    const cardContent = formatContent(clean((sections[s.key] && sections[s.key].text) || sections[s.key] || ""));
    const sectionSrcs = sourcesBySection[s.label] || [];
    const srcStrip = sectionSrcs.length > 0
      ? `<div class="src-strip"><div class="src-strip-label">📎 Sources (${sectionSrcs.length})</div><div class="src-strip-links">${sectionSrcs.map(src => `<a class="src-strip-link" href="${src.url}" target="_blank" rel="noopener" title="${src.title}">${src.title}</a>`).join("")}</div></div>`
      : "";
    return `
    <div class="section" id="${s.id}">
      <div class="section-hdr">${s.icon} ${s.label}</div>
      <div class="card"><div class="card-body">${cardContent}</div>${srcStrip}</div>
    </div>`;
  }).join("");

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
  .top-bar, .pdf-banner, .sec-nav, .sources-panel { display: none !important; }
  .src-strip { border-top: 1px solid #E2E5EC; background: none; }
  .src-strip-link { border: 1px solid #E2E5EC; background: none; }
  .gap-fill-block { background: none !important; border-left: 2px solid #F59E0B; }
  .departed-block { background: none !important; border-left: 2px solid #EF4444; }
  .verify-block { background: none !important; border-left: 2px solid #3B82F6; }
  .conf-panel { display: none !important; }
  .cf-badge { border: 1px solid #999; background: none !important; color: #555; }
  body { padding-bottom: 0; background: #fff; font-size: 12px; }
  .hero { padding: 16px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hero-company { font-size: 20px; }
  .section { padding: 10px 8px 0; }
  .card { box-shadow: none; border: 1px solid #E2E5EC; break-inside: avoid; margin-bottom: 8px; }
  /* Strip colored backgrounds for clean print */
  .content-item { padding: 8px 10px; }
  .sp-pitch { background: none !important; border-left: 2px solid #2E74B5; padding: 8px 10px; }
  .sp-pitch-tag { font-weight: 700; }
  .sp-landmine { background: none !important; border-left: 2px solid #BF8A14; padding: 6px 10px; margin-bottom: 4px; }
  .sp-entry { background: none !important; border-left: 2px solid #059669; padding: 8px 10px; }
  .sp-nextstep { background: none !important; border: 1px solid #E2E5EC; padding: 8px; }
  .content-num { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hero-badge { background: none !important; border: 1px solid rgba(255,255,255,.5); }
  .report-footer { border-top: 1px solid #1F3864; }
  a { text-decoration: none; color: inherit; }
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

/* Section source strip */
.src-strip { padding: 8px 14px 10px; border-top: 0.5px solid var(--border); background: #FAFBFC; }
.src-strip-label { font-size: 9px; font-weight: 700; color: var(--t3); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
.src-strip-links { display: flex; flex-wrap: wrap; gap: 5px; }
.src-strip-link { font-size: 10px; color: var(--blue); text-decoration: none; background: var(--lblue); padding: 2px 8px; border-radius: 10px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; border: 1px solid #C4DCF0; }
.src-strip-link:hover { background: #D6EAF8; }

/* Gap fill badge */
.gap-fill-block { background: #FFFBEB; border-left: 3px solid #F59E0B; padding: 8px 12px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.gap-fill-tag { display: inline-block; background: #F59E0B; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.gap-fill-note { font-size: 11px; color: #92600A; font-style: italic; margin-top: 3px; }
.gap-fill-content { font-size: 12.5px; color: #78350F; line-height: 1.65; margin-top: 4px; }

/* Leadership verification blocks */
.departed-block { background: #FEF2F2; border-left: 3px solid #EF4444; padding: 8px 12px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.departed-tag { display: inline-block; background: #EF4444; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.departed-content { font-size: 12.5px; color: #991B1B; line-height: 1.65; margin-top: 4px; }
.verify-block { background: #EFF6FF; border-left: 3px solid #3B82F6; padding: 8px 12px; border-radius: 0 6px 6px 0; margin: 6px 0; }
.verify-tag { display: inline-block; background: #3B82F6; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.verify-content { font-size: 12.5px; color: #1E40AF; line-height: 1.65; margin-top: 4px; }

/* Inline confidence badges */
.cf-badge { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; letter-spacing: .05em; text-transform: uppercase; vertical-align: middle; margin-left: 3px; cursor: default; white-space: nowrap; }
.cf-inferred   { background: #FEF3C7; color: #92600A; border: 1px solid #F59E0B; }
.cf-unverified { background: #FEE2E2; color: #991B1B; border: 1px solid #F87171; }
.cf-assumed    { background: #F3F4F6; color: #374151; border: 1px solid #9CA3AF; }
.cf-outdated   { background: #EFF6FF; color: #1E40AF; border: 1px solid #93C5FD; }

/* Confidence notes panel */
.conf-panel { margin: 0 14px 16px; border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.conf-toggle { width: 100%; background: #7C3AED; color: #fff; border: none; padding: 12px 16px; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.conf-chevron { transition: transform .2s; }
.conf-panel.open .conf-chevron { transform: rotate(180deg); }
.conf-body { display: none; background: var(--card); }
.conf-panel.open .conf-body { display: block; }
.conf-item { display: flex; gap: 10px; padding: 10px 14px; border-bottom: 0.5px solid var(--border); align-items: flex-start; }
.conf-item:last-child { border-bottom: none; }
.conf-item-left { flex-shrink: 0; padding-top: 2px; }
.conf-item-right { flex: 1; min-width: 0; }
.conf-item-section { font-size: 9px; font-weight: 700; color: var(--t3); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 3px; }
.conf-item-quote { font-size: 12px; color: var(--t2); font-style: italic; line-height: 1.5; margin-bottom: 3px; }
.conf-item-note { font-size: 11px; color: var(--t3); }
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

<!-- CONFIDENCE NOTES PANEL -->
${buildConfPanel(confidenceFlags)}

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
  const sectionLabelMap = Object.fromEntries(sectionList.map(s => [s.key, s.label]));

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
          section: (sectionLabelMap[gap.section] || gap.section) + " (gap fill)"
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

  // ── Step 4.5: Leadership departure verification ──────────────────────────────
  process.stdout.write(`🔍 [Web Scraping Agent] Verifying leadership departures...`);
  try {
    const verif = await verifyLeadershipDepartures(company, sections.s3.text);
    sections.s3.text += `\n\n[LEADERSHIP VERIFICATION] ${verif.text.slice(0, 1200)}`;
    if (verif.sources.length) {
      allSources.push(...verif.sources.map(s => ({ ...s, section: "Leadership & Org" })));
    }
    console.log(` ✅`);
  } catch(e) {
    console.log(` ⚠️  Skipped: ${e.message.slice(0, 50)}`);
  }

  // ── Step 5: GPT-4o confidence audit ─────────────────────────────────────────
  let confidenceFlags = [];
  if (process.env.OPENAI_API_KEY) {
    process.stdout.write(`🔍 [Audit Agent] Confidence check (GPT-4o)...`);
    try {
      confidenceFlags = await auditConfidence(company, sections);
      let matched = 0;
      for (const flag of confidenceFlags) {
        const sec = sections[flag.section];
        if (!sec || !sec.text || !flag.quote) continue;
        const marker = ` [[CF:${flag.type}:${flag.note}]]`;

        // Try 1: exact match
        let idx = sec.text.indexOf(flag.quote);
        if (idx !== -1) {
          sec.text = sec.text.slice(0, idx + flag.quote.length) + marker + sec.text.slice(idx + flag.quote.length);
          matched++; continue;
        }

        // Try 2: normalise whitespace (handles line-break differences)
        const normText = sec.text.replace(/\s+/g, " ");
        const normQuote = flag.quote.replace(/\s+/g, " ").trim();
        const normIdx = normText.indexOf(normQuote);
        if (normIdx !== -1) {
          // Find the same position in original text using first 6 words
          const anchor = normQuote.split(" ").slice(0, 6).join(" ");
          const anchorIdx = sec.text.indexOf(anchor);
          if (anchorIdx !== -1) {
            const insertAt = anchorIdx + anchor.length;
            sec.text = sec.text.slice(0, insertAt) + marker + sec.text.slice(insertAt);
            matched++; continue;
          }
        }

        // Try 3: first 5 words of quote as anchor
        const shortAnchor = flag.quote.trim().split(/\s+/).slice(0, 5).join(" ");
        if (shortAnchor.length > 15) {
          const shortIdx = sec.text.indexOf(shortAnchor);
          if (shortIdx !== -1) {
            const insertAt = shortIdx + shortAnchor.length;
            sec.text = sec.text.slice(0, insertAt) + marker + sec.text.slice(insertAt);
            matched++;
          }
        }
      }
      console.log(` ✅ (${confidenceFlags.length} flagged, ${matched} matched in text)`);
    } catch(e) {
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

  // ── Step 7: Build HTML ───────────────────────────────────────────────────────
  const html = buildHTML(company, sections, uniqueSources, confidenceFlags);
  if (!fs.existsSync("reports")) fs.mkdirSync("reports");
  const outPath = path.join("reports", `${slug}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`\n✅ Report saved: ${outPath} (${uniqueSources.length} sources)`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});