require("dotenv").config();
const fs = require("fs");
const path = require("path");

const company = process.env.COMPANY || process.argv[2];
if (!company) {
  console.error("Usage: COMPANY='IKEA' node build-html.js");
  process.exit(1);
}

const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "_");
const contentPath = path.join("reports", `${slug}.content.json`);

if (!fs.existsSync(contentPath)) {
  console.error(`❌ Content file not found: ${contentPath}`);
  console.error(`   Run: node generate-content.js "${company}" first`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(contentPath, "utf8"));

// ─── Inject inline confidence badges ─────────────────────────────────────────
function injectConfidenceBadges(text) {
  if (!text) return "";
  return text.replace(/\[\[CF:(\w+):([^\]]*)\]\]/g, (_, type, note) => {
    const labels = { inferred: "Inferred", unverified: "Unverified", assumed: "Assumed", outdated: "Outdated" };
    const safeNote = note.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<span class="cf-badge cf-${type}" title="${safeNote}">${labels[type] || type}</span>`;
  });
}

// ─── Escape HTML special characters ──────────────────────────────────────────
function esc(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Render a single body block ───────────────────────────────────────────────
function renderBlock(block) {
  if (!block) return "";
  const text = injectConfidenceBadges(block.text || "");
  switch (block.type) {
    case "text":
      return `<div class="content-text">${text}</div>`;
    case "bullet":
      return `<div class="content-bullet"><span class="bullet-dot"></span><span>${text}</span></div>`;
    case "table":
      return renderTable(block);
    default:
      return text ? `<div class="content-text">${text}</div>` : "";
  }
}

// ─── Render a table block ─────────────────────────────────────────────────────
function renderTable(block) {
  if (!block.headers || !block.rows) return "";
  const thead = `<tr>${block.headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = block.rows.map(row =>
    `<tr>${row.map(cell => `<td>${esc(String(cell))}</td>`).join("")}</tr>`
  ).join("");
  return `<div class="tbl-wrap"><table class="data-table">${thead}${tbody}</table></div>`;
}

// ─── Render a single content item (numbered circle + label + body) ────────────
function renderItem(item) {
  if (!item) return "";

  if (item.type === "gapfill") {
    return `<div class="gap-fill-block">
      <span class="gap-fill-tag">Gap Fill</span>${item.note ? ` <span class="gap-fill-note">${esc(item.note)}</span>` : ""}
      <div class="gap-fill-content">${injectConfidenceBadges(item.text || "")}</div>
    </div>`;
  }
  if (item.type === "leadershipVerification") {
    return `<div class="verify-block">
      <span class="verify-tag">Leadership Verified</span>
      <div class="verify-content">${injectConfidenceBadges(item.text || "")}</div>
    </div>`;
  }
  if (item.type === "departed") {
    return `<div class="departed-block">
      <span class="departed-tag">Departed</span>
      <div class="departed-content">${injectConfidenceBadges(item.text || "")}</div>
    </div>`;
  }

  // Numbered item
  const bodyHtml = (item.body || []).map(renderBlock).join("");
  return `<div class="content-item">
    <div class="content-num">${item.num}</div>
    <div class="content-body">
      <div class="content-label">${esc(item.label || "")}</div>
      ${bodyHtml}
    </div>
  </div>`;
}

// ─── Render leadership person cards ──────────────────────────────────────────
function renderLeadershipPeople(people) {
  if (!people || people.length === 0) return "";
  const cards = people.map(p => `
    <div class="person-card">
      ${p.name ? `<div class="person-name">${esc(p.name)}</div>` : ""}
      ${p.role ? `<div class="person-role">${esc(p.role)}</div>` : ""}
      ${p.tenure ? `<div class="person-tenure">In role: ${esc(p.tenure)}</div>` : ""}
      ${p.background ? `<div class="person-bg">${esc(p.background)}</div>` : ""}
      ${(p.details || []).map(d => `<div class="person-detail">${esc(d)}</div>`).join("")}
    </div>`).join("");
  return `<div class="people-section">${cards}</div>`;
}

// ─── Render Sales Play (s6) ───────────────────────────────────────────────────
function renderSalesPlay(salesPlay) {
  if (!salesPlay) return `<div class="content-text">Sales play not available.</div>`;

  let html = "";

  // 1. Pitch angle
  const pitch = salesPlay.pitch || {};
  html += `<div class="content-item">
    <div class="content-num">1</div>
    <div class="content-body">
      <div class="content-label">Recommended Pitch Angle</div>
      <div class="sp-pitch">
        ${pitch.title ? `<div class="sp-pitch-tag">${esc(pitch.title)}</div>` : ""}
        ${pitch.body ? `<div class="sp-pitch-text">${esc(pitch.body)}</div>` : ""}
      </div>
    </div>
  </div>`;

  // 2. Opener questions
  const openers = salesPlay.openers || [];
  html += `<div class="content-item">
    <div class="content-num">2</div>
    <div class="content-body">
      <div class="content-label">Conversation Opener Questions</div>
      ${openers.map(q => `<div class="content-bullet"><span class="bullet-dot"></span><span>${esc(q)}</span></div>`).join("")}
    </div>
  </div>`;

  // 3. Landmines
  const landmines = salesPlay.landmines || [];
  html += `<div class="content-item">
    <div class="content-num">3</div>
    <div class="content-body">
      <div class="content-label">Landmines to Avoid</div>
      ${landmines.map(lm => `<div class="sp-landmine">
        ${lm.title ? `<div class="sp-landmine-title">⚠️ ${esc(lm.title)}</div>` : ""}
        ${lm.text  ? `<div class="sp-landmine-text">${esc(lm.text)}</div>` : ""}
      </div>`).join("")}
    </div>
  </div>`;

  // 4. Next step
  html += `<div class="content-item">
    <div class="content-num">4</div>
    <div class="content-body">
      <div class="content-label">Suggested Next Step</div>
      <div class="sp-nextstep">${esc(salesPlay.nextStep || "")}</div>
    </div>
  </div>`;

  // 5. Best entry point
  const entry = salesPlay.entry || {};
  html += `<div class="content-item">
    <div class="content-num">5</div>
    <div class="content-body">
      <div class="content-label">Best Entry Point</div>
      <div class="sp-entry">
        ${entry.name ? `<div class="sp-entry-name">${esc(entry.name)}</div>` : ""}
        ${entry.role ? `<div class="sp-entry-role">${esc(entry.role)}</div>` : ""}
        ${entry.text ? `<div class="sp-entry-text">${esc(entry.text)}</div>` : ""}
      </div>
    </div>
  </div>`;

  return html;
}

// ─── Confidence notes panel ───────────────────────────────────────────────────
function buildConfPanel(flags) {
  if (!flags || flags.length === 0) return "";
  const sectionLabels = {
    s1: "Company Snapshot", s2: "Strategic Direction", s3: "Leadership & Org",
    s4: "Buying Signals",   s5: "Competitive & Vendors"
  };
  const typeLabels = { inferred: "Inferred", unverified: "Unverified", assumed: "Assumed", outdated: "Outdated" };
  const items = flags.map(f => `
    <div class="conf-item">
      <div class="conf-item-left"><span class="cf-badge cf-${f.type}">${typeLabels[f.type] || f.type}</span></div>
      <div class="conf-item-right">
        <div class="conf-item-section">${esc(sectionLabels[f.section] || f.section)}</div>
        <div class="conf-item-quote">"${esc(f.quote)}"</div>
        <div class="conf-item-note">${esc(f.note)}</div>
      </div>
    </div>`).join("");

  return `
<div class="conf-panel">
  <button class="conf-toggle" onclick="this.parentElement.classList.toggle('open')">
    ⚠️ Confidence Notes — ${flags.length} item${flags.length !== 1 ? "s" : ""} flagged for review
    <span class="conf-chevron">▼</span>
  </button>
  <div class="conf-body">${items}</div>
</div>`;
}

// ─── Sources panel ────────────────────────────────────────────────────────────
function buildSourcesPanel(sources) {
  if (!sources || sources.length === 0) return "";
  const grouped = {};
  sources.forEach(s => {
    const sec = s.section || "General";
    if (!grouped[sec]) grouped[sec] = [];
    grouped[sec].push(s);
  });
  let srcHtml = "";
  Object.entries(grouped).forEach(([sec, srcs]) => {
    srcHtml += `<div class="src-group"><div class="src-group-label">${esc(sec)}</div>`;
    srcs.forEach(s => {
      srcHtml += `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`;
    });
    srcHtml += `</div>`;
  });
  return `
<div class="sources-panel">
  <button class="sources-toggle" onclick="this.parentElement.classList.toggle('open')">
    📎 Sources &amp; References (${sources.length}) <span class="src-chevron">▼</span>
  </button>
  <div class="sources-body">${srcHtml}</div>
</div>`;
}

// ─── Section source strip ─────────────────────────────────────────────────────
function buildSrcStrip(srcs) {
  if (!srcs || srcs.length === 0) return "";
  return `<div class="src-strip">
    <div class="src-strip-label">📎 Sources (${srcs.length})</div>
    <div class="src-strip-links">
      ${srcs.map(s => `<a class="src-strip-link" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${esc(s.title)}</a>`).join("")}
    </div>
  </div>`;
}

// ─── Full HTML build ──────────────────────────────────────────────────────────
function buildHTML(d) {
  const { company, slug, generatedAt, ownership, sections, sources, confidenceFlags } = d;
  const generated = new Date(generatedAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });

  const sectionDefs = [
    { key: "s1", id: "snapshot",   label: "Company Snapshot",     icon: "🏢" },
    { key: "s2", id: "strategy",   label: "Strategic Direction",   icon: "🎯" },
    { key: "s3", id: "leadership", label: "Leadership & Org",      icon: "👥" },
    { key: "s4", id: "signals",    label: "Buying Signals",        icon: "📡" },
    { key: "s5", id: "vendors",    label: "Competitive & Vendors", icon: "🔍" },
    { key: "s6", id: "salesplay",  label: "Sales Play",            icon: "⚡" },
  ];

  // Group sources by section label for per-card strips
  const srcBySection = {};
  (sources || []).forEach(s => {
    const label = (s.section || "General").replace(" (gap fill)", "");
    if (!srcBySection[label]) srcBySection[label] = [];
    srcBySection[label].push(s);
  });

  const navPills = sectionDefs
    .map(s => `<a href="#${s.id}">${s.icon} ${s.label}</a>`)
    .join("");

  const sectionCards = sectionDefs.map(s => {
    const sec = sections[s.key];
    let cardContent = "";

    if (s.key === "s6") {
      cardContent = renderSalesPlay(sec?.salesPlay);
    } else {
      cardContent = (sec?.items || []).map(renderItem).join("");
      if (s.key === "s3" && sec?.people?.length > 0) {
        cardContent += renderLeadershipPeople(sec.people);
      }
    }

    const strip = buildSrcStrip(srcBySection[s.label] || []);

    return `
    <div class="section" id="${s.id}">
      <div class="section-hdr">${s.icon} ${s.label}</div>
      <div class="card">
        <div class="card-body">${cardContent}</div>
        ${strip}
      </div>
    </div>`;
  }).join("");

  const ownershipLabel = ownership || "Ownership: Verify";
  const ownershipIcon  = ownership ? "🏛" : "⚠️";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>ITC Infotech · ${esc(company)} · Account Intelligence</title>
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

/* ── Top bar ── */
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

/* ── Hero ── */
.hero {
  background: linear-gradient(135deg, var(--navy) 0%, #2E74B5 100%);
  padding: 24px 16px 20px;
}
.hero-label { color: var(--vblue); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
.hero-company { color: #fff; font-size: 24px; font-weight: 700; margin-bottom: 12px; }
.hero-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.hero-badge { background: rgba(255,255,255,.12); color: #fff; font-size: 10px; font-weight: 600; padding: 4px 12px; border-radius: 20px; }

/* ── PDF banner ── */
.pdf-banner {
  background: var(--lblue); border-bottom: 1px solid #C4DCF0;
  padding: 10px 16px; display: flex; justify-content: space-between; align-items: center;
}
.pdf-banner-text { font-size: 12px; color: var(--navy); font-weight: 500; }
.pdf-btn { background: var(--navy); color: #fff; font-size: 11px; font-weight: 600; padding: 7px 16px; border-radius: 20px; text-decoration: none; }

/* ── Sections ── */
.section { padding: 20px 14px 0; }
.section-hdr { font-size: 11px; font-weight: 700; color: var(--navy); letter-spacing: .1em; text-transform: uppercase; margin-bottom: 10px; }
.card { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 12px; }
.card-body { padding: 0; }

/* ── Content items ── */
.content-item {
  display: flex; gap: 12px;
  padding: 14px 16px;
  border-bottom: 0.5px solid var(--border);
  min-width: 0;
}
.content-item:last-child { border-bottom: none; }
.content-num {
  flex-shrink: 0; width: 24px; height: 24px;
  background: var(--navy); color: #fff; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; margin-top: 2px;
}
.content-body { flex: 1; min-width: 0; overflow-wrap: break-word; word-break: break-word; }
.content-label { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.content-text { font-size: 13px; color: var(--t2); line-height: 1.7; margin-bottom: 6px; }
.content-text:last-child { margin-bottom: 0; }

/* ── Bullets ── */
.content-bullet { display: flex; gap: 10px; padding: 3px 0; }
.bullet-dot { flex-shrink: 0; width: 5px; height: 5px; background: var(--blue); border-radius: 50%; margin-top: 8px; }
.content-bullet > span:last-child { font-size: 12.5px; color: var(--t2); line-height: 1.6; }

/* ── Tables ── */
.tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 6px 0; }
.data-table { border-collapse: collapse; width: 100%; font-size: 12px; min-width: 300px; }
.data-table th { background: var(--navy); color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; font-weight: 600; white-space: nowrap; }
.data-table td { padding: 8px 10px; border-bottom: 0.5px solid var(--border); color: var(--t2); vertical-align: top; line-height: 1.5; }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:nth-child(even) td { background: #FAFBFC; }

/* ── Sales Play ── */
#salesplay .card { border-top: 3px solid var(--blue); }
.sp-pitch { background: #EBF3FB; border-left: 3px solid var(--blue); padding: 12px 14px; border-radius: 0 6px 6px 0; margin: 4px 0 8px; }
.sp-pitch-tag { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
.sp-pitch-text { font-size: 13px; color: var(--t1); line-height: 1.65; }
.sp-landmine { background: #FFF8EC; border-left: 3px solid var(--amber); padding: 10px 14px; border-radius: 0 6px 6px 0; margin-bottom: 8px; }
.sp-landmine:last-child { margin-bottom: 0; }
.sp-landmine-title { font-size: 12px; font-weight: 700; color: #92600A; margin-bottom: 3px; }
.sp-landmine-text  { font-size: 12px; color: #78350F; line-height: 1.6; }
.sp-nextstep { background: #F8F9FA; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 4px 0; font-size: 13px; color: var(--t2); line-height: 1.65; }
.sp-entry { background: #F0FDF4; border-left: 3px solid #16a34a; padding: 12px 14px; border-radius: 0 6px 6px 0; margin: 4px 0; }
.sp-entry-name { font-size: 15px; font-weight: 700; color: #166534; margin-bottom: 2px; }
.sp-entry-role { font-size: 11px; font-weight: 600; color: #16a34a; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
.sp-entry-text { font-size: 12.5px; color: #166534; line-height: 1.6; }

/* ── Leadership person cards ── */
.people-section { padding: 14px 16px; border-top: 0.5px solid var(--border); display: flex; flex-wrap: wrap; gap: 10px; }
.person-card { flex: 1 1 260px; background: #F8F9FA; border-radius: 8px; padding: 12px 14px; border-left: 3px solid var(--blue); }
.person-name   { font-size: 14px; font-weight: 700; color: var(--navy); margin-bottom: 2px; }
.person-role   { font-size: 11px; font-weight: 600; color: var(--blue); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.person-tenure { font-size: 11px; color: var(--t3); margin-bottom: 5px; }
.person-bg     { font-size: 12.5px; color: var(--t2); line-height: 1.6; }
.person-detail { font-size: 12px; color: var(--t2); margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--border); }

/* ── Special blocks ── */
.gap-fill-block  { background: #FFFBEB; border-left: 3px solid #F59E0B; padding: 10px 14px; margin: 4px 14px; border-radius: 0 6px 6px 0; }
.gap-fill-tag    { display: inline-block; background: #F59E0B; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.gap-fill-note   { display: inline; font-size: 11px; color: #92600A; font-style: italic; }
.gap-fill-content{ font-size: 12.5px; color: #78350F; line-height: 1.65; margin-top: 6px; }

.departed-block  { background: #FEF2F2; border-left: 3px solid #EF4444; padding: 10px 14px; margin: 4px 14px; border-radius: 0 6px 6px 0; }
.departed-tag    { display: inline-block; background: #EF4444; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.departed-content{ font-size: 12.5px; color: #991B1B; line-height: 1.65; margin-top: 6px; }

.verify-block    { background: #EFF6FF; border-left: 3px solid #3B82F6; padding: 10px 14px; margin: 4px 14px; border-radius: 0 6px 6px 0; }
.verify-tag      { display: inline-block; background: #3B82F6; color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 1px 5px; letter-spacing: .06em; text-transform: uppercase; margin-right: 6px; vertical-align: middle; }
.verify-content  { font-size: 12.5px; color: #1E40AF; line-height: 1.65; margin-top: 6px; }

/* ── Inline confidence badges ── */
.cf-badge { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; letter-spacing: .05em; text-transform: uppercase; vertical-align: middle; margin-left: 3px; cursor: default; white-space: nowrap; }
.cf-inferred   { background: #FEF3C7; color: #92600A; border: 1px solid #F59E0B; }
.cf-unverified { background: #FEE2E2; color: #991B1B; border: 1px solid #F87171; }
.cf-assumed    { background: #F3F4F6; color: #374151; border: 1px solid #9CA3AF; }
.cf-outdated   { background: #EFF6FF; color: #1E40AF; border: 1px solid #93C5FD; }

/* ── Confidence notes panel ── */
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
.conf-item-note  { font-size: 11px; color: var(--t3); }

/* ── Sources panel ── */
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

/* ── Per-section source strip ── */
.src-strip { padding: 8px 14px 10px; border-top: 0.5px solid var(--border); background: #FAFBFC; }
.src-strip-label { font-size: 9px; font-weight: 700; color: var(--t3); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
.src-strip-links { display: flex; flex-wrap: wrap; gap: 5px; }
.src-strip-link { font-size: 10px; color: var(--blue); text-decoration: none; background: var(--lblue); padding: 2px 8px; border-radius: 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; border: 1px solid #C4DCF0; }
.src-strip-link:hover { background: #D6EAF8; }

/* ── Footer ── */
.report-footer { margin: 24px 14px 8px; padding: 16px; background: var(--card); border-radius: var(--radius); border-top: 2px solid var(--navy); }
.footer-disclaimer { font-size: 11px; color: var(--t3); line-height: 1.7; }
.footer-meta { font-size: 10px; color: var(--t3); text-align: center; font-style: italic; margin-top: 8px; }

/* ── Home FAB ── */
.fab-home { position: fixed; bottom: 20px; left: 16px; z-index: 200; background: var(--navy); color: #fff; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-decoration: none; font-size: 20px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }

/* ── Print ── */
@media print {
  .top-bar, .pdf-banner, .sources-panel, .conf-panel, .fab-home { display: none !important; }
  body { padding-bottom: 0; background: #fff; font-size: 12px; }
  .hero { padding: 16px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hero-company { font-size: 20px; }
  .section { padding: 10px 8px 0; }
  .card { box-shadow: none; border: 1px solid #E2E5EC; break-inside: avoid; margin-bottom: 8px; }
  .content-item { padding: 8px 10px; }
  .content-num { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hero-badge { background: none !important; border: 1px solid rgba(255,255,255,.5); }
  .sp-pitch { background: none !important; border-left: 2px solid #2E74B5; }
  .sp-landmine { background: none !important; border-left: 2px solid #BF8A14; }
  .sp-entry { background: none !important; border-left: 2px solid #059669; }
  .sp-nextstep { background: none !important; }
  .person-card { background: none !important; border-left: 2px solid #2E74B5; }
  .gap-fill-block  { background: none !important; border-left: 2px solid #F59E0B; }
  .departed-block  { background: none !important; border-left: 2px solid #EF4444; }
  .verify-block    { background: none !important; border-left: 2px solid #3B82F6; }
  .src-strip { background: none !important; }
  .cf-badge { border: 1px solid #999; background: none !important; color: #555; }
  a { text-decoration: none; color: inherit; }
  .report-footer { border-top: 1px solid #1F3864; }
}
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
  <div class="hero-company">${esc(company)}</div>
  <div class="hero-meta">
    <span class="hero-badge">📅 ${generated}</span>
    <span class="hero-badge">${ownershipIcon} ${esc(ownershipLabel)}</span>
  </div>
</div>

<div class="pdf-banner">
  <div class="pdf-banner-text">📄 Download full report as PDF</div>
  <a class="pdf-btn" href="${esc(slug)}.pdf" download>Download PDF →</a>
</div>

${sectionCards}

<div class="report-footer">
  <div class="footer-disclaimer">This report was generated with AI assistance using publicly available sources including company websites, press releases, earnings calls, and news. AI tools can introduce errors — cross-check any data point before use in a conversation. Do not share outside ITC Infotech.</div>
  <div class="footer-meta">ITC Infotech · Account Intelligence Engine v0.3 · ${generated}</div>
</div>

${buildConfPanel(confidenceFlags || [])}
${buildSourcesPanel(sources || [])}

<a class="fab-home" href="../index.html" title="Back to portal">🏠</a>

</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const html = buildHTML(data);
const outPath = path.join("reports", `${slug}.html`);
fs.writeFileSync(outPath, html);
console.log(`✅ HTML built: ${outPath}`);
