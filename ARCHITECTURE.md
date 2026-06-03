# Account Intelligence Engine — Technical Architecture
**File:** ARCHITECTURE.md
**Last Updated:** 3 June 2026
**Scope:** `generate.js` pipeline — account report generation

---

## System Overview

```
User (account.html)
      │ types company name
      ▼
Render Server (server.js)
      │ POST /canonicalize → OpenAI GPT-4o-mini
      │ returns canonical name ("apple" → "Apple Inc.")
      │ POST /generate → GitHub API workflow_dispatch
      ▼
GitHub Actions (generate.yml)
      │ injects secrets as env vars
      │ runs: node generate.js "Company Name"
      ▼
generate.js pipeline (7 steps)
      │
      ▼
reports/slug.html + reports/slug.pdf
      │ committed to repo
      ▼
GitHub Pages (live URL)
```

---

## generate.js — Complete Pipeline

### STEP 1 — Gemini Research (5 calls)

```
Model:   Gemini 2.5 Flash + Google Search grounding
Calls:   5 sequential calls, one per section
Retries: Up to 3× on 429 or RECITATION block
         On RECITATION: prepends paraphrase instruction

Sections researched:
  S1  Company Snapshot
      → revenue, margin trend, employees, India GCC,
        recent news, M&A, ownership, competitors

  S2  Strategic Direction
      → corporate vision, big initiatives, tech strategy

  S3  Leadership & Org
      → key decision makers (CEO/CFO/CIO/COO),
        recent changes, org structure, board composition
      CRITICAL: prompt explicitly instructs Gemini to search
      for executive departures before listing anyone

  S4  Buying Signals
      → financial stress, tech pain, operational pain,
        hiring signals, timing triggers

  S5  Competitive & Vendors
      → tech stack, SI partners, procurement signals,
        competitive dynamics

Each returns:
  { text: "raw research prose", sources: [{url, title}] }

Sources collected into allSources[] with section label tag.
```

---

### STEP 2 — Claude Gap Check (1 call)

```
Model:   Claude Sonnet (claude-sonnet-4-5)
Input:   First 800 chars of each section text
Output:  JSON array: [{section, gap, query}]  max 5 items
Purpose: Identify specific missing data worth filling
         (missing financials, unknown execs, vague tech stack)
```

---

### STEP 3 — Gemini Gap Fill (0–5 calls)

```
Model:   Gemini 2.5 Flash + Google Search
Trigger: One call per gap found in Step 2
Output:  Targeted research text + sources

Appended to section text as:
  "[GAP FILL] {filled text}"

Sources tagged as: "Section Label (gap fill)"
```

---

### STEP 4 — Claude S6 Synthesis (1 call)

```
Model:   Claude Sonnet (claude-sonnet-4-5)
Input:   All 5 section texts combined
Output:  Plain text Sales Play with 5 blocks:
           1. RECOMMENDED PITCH ANGLE
           2. CONVERSATION OPENER QUESTIONS
           3. LANDMINES TO AVOID
           4. SUGGESTED NEXT STEP
           5. BEST ENTRY POINT

Stored as sections.s6.text
Note: S6 is NOT processed by Steps 4.5, 4.6, or 5
      It is handled exclusively by the JS post-processor
```

---

### STEP 4.5 — Leadership Departure Verification (1 Gemini call)

```
Model:   Gemini 2.5 Flash + Google Search
Input:   S3 text (first 1200 chars)
Queries: "[company] executive departure OR left OR resigned 2024 2025 2026"
         "[company] new CEO CFO CIO COO appointed 2025 2026"

Output structure:
  CONFIRMED DEPARTED: name, role, date, destination
  UNCONFIRMED STILL IN ROLE: name, role
  CONFIRMED STILL IN ROLE: name, role, source/date

Appended to S3 text as:
  "[LEADERSHIP VERIFICATION] {verification text}"

Purpose: Catch the "Bakker problem" — executives who left
         but still appear in Gemini's S3 research output
```

---

### STEP 4.6 — GPT-4o-mini Content Formatter (1 call)

```
Model:   GPT-4o-mini (response_format: json_object)
Input:   All 5 raw section texts (S1–S5)
Output:  {"s1": "...", "s2": "...", "s3": "...", "s4": "...", "s5": "..."}
Max tokens: 8000

Transformations applied:
  ✓ Add/fix numbered headers: "1. LABEL NAME:\n"
  ✓ Convert prose lists → bullet points ("- " prefix)
  ✓ Split dense paragraphs (max 3 sentences, blank line between)
  ✓ Preserve markdown tables (|col|col| format)
  ✓ Preserve verbatim: [GAP FILL...], [LEADERSHIP VERIFICATION], [DEPARTED...]
  ✓ Remove generic intro sentences

Purpose: Ensure formatContent() receives consistently structured
         input regardless of Gemini's output variability.
         Also improves confidence audit quote matching (Step 5).

Fallback: If call fails, original text is kept for each section.
Cost: ~$0.006 per report
```

---

### STEP 5 — GPT-4o Confidence Audit (1 call)

```
Model:   GPT-4o (response_format: json_object)
Input:   S1–S5 formatted text (first 1800 chars each)
Output:  {"flags": [{section, quote, type, note}]}  max 12 flags

Flag types:
  unverified  → stated as fact, no reliable public source
  inferred    → derived from indirect evidence (job postings, LinkedIn)
  assumed     → working assumption, no evidence cited
  outdated    → data likely stale (>18 months old)

Injection into text:
  For each flag, finds the quoted phrase in section text
  Appends: " [[CF:type:note]]" after the phrase

  3-tier matching (most to least strict):
    1. Exact indexOf match
    2. Whitespace-normalised match → first 6-word anchor
    3. First 5 words of quote as anchor (if >15 chars)

Condition: Only runs if OPENAI_API_KEY is set.
           If missing: skipped, no badges shown.
```

---

### STEP 6 — Source Deduplication

```
Deduplicates allSources[] by URL
Preserves first occurrence of each URL
```

---

### STEP 7 — buildHTML()

```
Signature: buildHTML(company, sections, sources, confidenceFlags)

HTML structure produced:
  ┌─ <head> — CSS (all styles inline in file)
  ├─ .top-bar — sticky nav with section pills
  ├─ .hero — company name, date, ownership badge
  ├─ .pdf-banner — PDF download link
  ├─ Section cards × 6
  │   ├─ .section-hdr — emoji + section name
  │   ├─ .card
  │   │   ├─ .card-body — formatContent() output
  │   │   └─ .src-strip — 📎 source pills (if sources exist)
  ├─ .report-footer — disclaimer + version
  ├─ .conf-panel — ⚠️ Confidence Notes (collapsible, purple)
  └─ .sources-panel — 📎 All Sources (collapsible, navy)
  └─ <script> — in-browser post-processors
```

---

## formatContent() — Text → HTML Parser

```
Input: one section's text blob
Processes line by line in this priority order:

  1. Empty line          → skip

  2. Markdown table      → <div class="tbl-wrap">
     (line starts |)       <table class="data-table">

  3. Numbered header     → <div class="content-item">
     regex: /^(\d+)\.\s+   <div class="content-num">N</div>
     ([A-Za-z]...)?:/       <div class="content-body">
     (case-insensitive)       <div class="content-label">LABEL</div>
     label → .toUpperCase()   {sub-content}
                            </div>
                          </div>

  4. [DEPARTED...]       → <div class="departed-block">
                            <span class="departed-tag">⚠ Departed</span>

  5. [LEADERSHIP         → <div class="verify-block">
     VERIFICATION]         <span class="verify-tag">✓ Leadership Verified</span>

  6. [GAP FILL...]       → <div class="gap-fill-block">
                            <span class="gap-fill-tag">Gap Fill</span>
                            [optional note in italic]

  7. Bullet (- / • / *)  → <div class="content-bullet">
                            <span class="bullet-dot">●</span>

  8. Regular text        → <div class="content-text">

  All text output (steps 3, 7, 8) passes through:
    injectConfidenceBadges(text)
    → replaces [[CF:type:note]] with:
      <span class="cf-badge cf-{type}" title="{note}">{Type}</span>
```

---

## In-Browser JavaScript Post-Processors

Runs at page load, 5 sequential passes:

```
PASS 1 — Orphan Rebuilder
  Scans all .card-body elements
  Finds .content-text elements with /^\d+\.\s+[A-Za-z]/ pattern
  Groups following siblings under numbered header
  Creates .content-item wrappers with .content-num circles
  (Fallback for any content formatContent() may have missed)

PASS 2 — Orphan Mover
  Finds .content-text / .content-bullet elements sitting
  directly in .card-body (outside any .content-item)
  Moves them into the previous .content-item's .content-body
  Safety net for stray elements after Pass 1

PASS 3 — Sales Play Formatter
  Targets #salesplay .card-body
  Reads full innerText, extracts 5 blocks by marker:
    RECOMMENDED PITCH ANGLE → sp-pitch block
    CONVERSATION OPENER QUESTIONS → content-bullet × N
    LANDMINES TO AVOID → sp-landmine blocks (amber, with title)
    SUGGESTED NEXT STEP → sp-nextstep box
    BEST ENTRY POINT → sp-entry block (green)
  Pitch body / entry text: joined with <br><br> (paragraph breaks)
  Next step: \n converted to <br><br> for paragraph breaks

PASS 4 — Ownership Badge Updater
  Scans #snapshot .card-body innerText
  Auto-detects: NASDAQ/NYSE → "Public Company"
               PE/KKR/Blackstone → "PE-Backed"
               private/family → "Private Company"
  Updates hero badge

PASS 5 — Leadership Card Formatter (setTimeout 50ms)
  Targets #leadership KEY DECISION MAKERS content-item
  Groups bullet lines by executive role
  Creates styled person cards:
    name (bold, navy) + role (blue, uppercase)
    tenure + background + detail lines
```

---

## Confidence Badge System

```
Badge types (inline in content):
  cf-inferred   → amber bg, amber border  — "Inferred"
  cf-unverified → red bg, red border      — "Unverified"
  cf-assumed    → grey bg, grey border    — "Assumed"
  cf-outdated   → blue bg, blue border    — "Outdated"

Hover → tooltip shows the specific reason

Confidence Notes Panel (⚠️ purple, collapsible):
  Lists all flagged items with:
    - Section name
    - Quoted phrase (italic)
    - Reason note
  Appears below footer, above Sources panel
  Hidden in PDF (@media print)
```

---

## Special Content Blocks

```
[GAP FILL]                → amber left border, amber badge
                             Secondary research appended to section

[LEADERSHIP VERIFICATION] → blue left border, blue badge
                             Executive departure check result

[DEPARTED]                → red left border, red badge
                             Confirmed executive departure
```

---

## Source Attribution System

```
Per-section source strips:
  Appear at bottom of each section card
  Pill-style links, truncated with ellipsis
  Only shown if that section has sources

All-sources panel:
  Collapsible, navy background, at page bottom
  Sources grouped by section label
  Gap fill sources labelled: "Section Name (gap fill)"

In PDF (@media print):
  Source strips: shown (styled for print)
  All-sources panel: hidden
```

---

## API Cost Per Report

| Step | Agent Label (UI) | Model | Approx Cost |
|------|-----------------|-------|-------------|
| Canonicalize | — | GPT-4o-mini | ~$0.001 |
| S1–S5 research | Web Scraping Agent | Gemini 2.5 Flash | ~$0.02–0.05 |
| Gap check | Synthesizing Agent | Claude Sonnet | ~$0.01 |
| Gap fills | Web Scraping Agent | Gemini 2.5 Flash | ~$0–0.02 |
| S6 synthesis | Synthesizing Agent | Claude Sonnet | ~$0.02 |
| Leadership verify | Web Scraping Agent | Gemini 2.5 Flash | ~$0.005 |
| Content formatter | Format Agent | GPT-4o-mini | ~$0.006 |
| Confidence audit | Audit Agent | GPT-4o | ~$0.02 |
| **Total** | | | **~$0.08–0.13** |

---

## GitHub Actions Workflow (generate.yml)

```yaml
Trigger: workflow_dispatch (company name input)

Steps:
  1. Checkout repo (with GH_PAT for push access)
  2. Setup Node.js 20
  3. npm install @google/generative-ai dotenv
  4. node generate.js
     env: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, COMPANY
  5. npm install puppeteer
  6. Generate PDF from HTML (inline Node script)
  7. Update reports/index.json (inline Node script)
  8. git add reports/ → git commit → git push

Secrets required:
  GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GH_PAT
```

---

## Key Design Constraints

- **No brand names in UI** — always "Web Scraping Agent", "Synthesizing Agent", "Format Agent", "Audit Agent"
- **Graceful degradation** — every AI step has try/catch; if it fails, pipeline continues with original data
- **No SDK dependencies** — Claude and OpenAI called via raw HTTPS to avoid npm version conflicts
- **formatContent() is case-insensitive** — handles both ALL-CAPS and mixed-case Gemini headers
- **S6 not formatted** — Sales Play text is never sent through the GPT-4o-mini formatter or confidence audit; it goes directly to the JS post-processor which has its own structure detection

---

*Last updated: 3 June 2026*
