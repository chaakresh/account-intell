# ITC Infotech Intelligence Portal — Master Context
**File:** MASTER_CONTEXT.md
**Created:** June 2026
**Last Updated:** 3 June 2026
**Purpose:** Context continuity for Claude Code and all future sessions on the account-intell project.

---

## 1. WHO I AM

**Chakresh Tibrewal** — Program Lead, Strategic Initiatives, ITC Infotech DxP Services (PLM Consulting).
- Reports to BU Head (weekly 30-min sync before leadership call)
- Works in CEO Office on executive market intelligence and strategic initiatives
- This role is a 4–6 month bridge toward a VP/Director position at a SaaS or tech company
- Weekly self-check: "What did I do this week that I can put on my resume with a number?"
- Boss's operating principle: "Your job is not to do it, your job is to make sure it gets created"

---

## 2. THE PROJECT — account-intell

A GitHub Pages-hosted intelligence portal for ITC Infotech leadership.
**Repo:** `github.com/Chaakresh/account-intell`
**Live URL:** `https://chaakresh.github.io/account-intell`
**Render server:** `https://account-intell.onrender.com`

### Portal structure
```
index.html          → Clean portal homepage (3 cards: Monthly, Daily, Account)
monthly.html        → Monthly Market Intelligence Report (manual update)
daily.html          → Daily Intelligence Brief (auto-updates at 7AM IST)
account.html        → Account Intelligence generator + report list
reports/            → Generated account intelligence HTML + PDF reports
reports/index.json  → Persistent report list (updated by GitHub Actions)
report.json         → Daily brief data (updated by GitHub Actions daily)
```

---

## 3. TECH STACK

### Languages
- **Node.js** — all generation scripts, Render server
- No Python (was used earlier, now fully migrated to Node.js)

### APIs
- **Gemini 2.5 Flash** (`@google/generative-ai`) — web scraping with Google Search grounding
- **Claude Sonnet** (`claude-sonnet-4-5` via HTTPS) — synthesis, gap checking, reasoning
- **OpenAI GPT-4o** (via HTTPS) — confidence audit (fact-checking, low-confidence flagging)
- **OpenAI GPT-4o-mini** (via HTTPS) — company name canonicalization + content formatting
- **GitHub API** — workflow dispatch via Render server

### Infrastructure
- **GitHub Pages** — static hosting (index.html, daily.html, account.html, reports/)
- **GitHub Actions** — two workflows: `generate.yml` (account reports) + `daily_report.yml` (daily brief)
- **Render (free tier)** — Node.js server holding secrets, proxying GitHub Actions triggers

### Key packages
```
@google/generative-ai   — Gemini API
dotenv                  — env vars locally
https (built-in)        — Claude + OpenAI API calls (no SDK — avoids npm version issues)
```

---

## 4. FILE INVENTORY (repo root)

| File | Purpose |
|------|---------|
| `generate.js` | Account report generator — full pipeline (see Section 6) |
| `scrape_daily.js` | Daily brief — Step 1: Gemini scrapes 6 sections, gap check/fill, saves `research_cache.json` |
| `synthesize_daily.js` | Daily brief — Step 2: reads cache, Claude synthesizes per section, saves `report.json` |
| `generate_daily.js` | Old combined daily script — **ignore, superseded** |
| `server.js` | Render server — `/canonicalize` (OpenAI GPT-4o-mini) + `/generate` (GitHub dispatch) |
| `package.json` | Node dependencies |
| `.env` | Local API keys — **does not exist in repo, create manually if needed** |
| `.gitignore` | Protects .env, research_cache.json, node_modules from being committed |
| `research_cache.json` | Interim scraping output (daily brief pipeline) — not committed |
| `report.json` | Daily brief output — committed daily by GitHub Actions |
| `reports/index.json` | Persistent list of all generated account reports with timestamps |
| `ARCHITECTURE.md` | Complete technical architecture of generate.js pipeline |

### GitHub Actions workflows
| File | Trigger | What it does |
|------|---------|-------------|
| `.github/workflows/generate.yml` | `workflow_dispatch` (from portal) | Runs `generate.js`, generates HTML + PDF, updates `reports/index.json` |
| `.github/workflows/daily_report.yml` | Cron `30 1 * * *` (7AM IST) + manual | Runs `scrape_daily.js` then `synthesize_daily.js`, commits `report.json` |

---

## 5. ENVIRONMENT VARIABLES

### Local `.env` (create manually — never commit)
```
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```
Note: `.env` file does not exist in the repo. Only needed for local testing.
Production runs entirely via GitHub Actions secrets.

### Render Environment Variables
```
GH_PAT=...              — GitHub Personal Access Token (repo + workflow scopes)
OPENAI_API_KEY=...      — GPT-4o-mini for canonicalization
```

### GitHub Secrets (in account-intell repo)
```
GEMINI_API_KEY          — Gemini API (web scraping)
ANTHROPIC_API_KEY       — Claude Sonnet (synthesis, gap check)
OPENAI_API_KEY          — GPT-4o (confidence audit) + GPT-4o-mini (formatter)
GH_PAT                  — GitHub PAT for committing reports
```

---

## 6. ACCOUNT REPORT PIPELINE (`generate.js`)

**Trigger:** User types company name in `account.html` → Render server canonicalizes via GPT-4o-mini → GitHub Actions triggers `generate.yml`

**Full pipeline (as of 3 June 2026):**
```
Step 1   Gemini × 5        Web research — S1 through S5 + sources
Step 2   Claude            Gap check → JSON list of missing data (max 5)
Step 3   Gemini × 0–5      Targeted gap fills → appended as [GAP FILL] blocks
Step 4   Claude            S6 Sales Play synthesis (plain text)
Step 4.5 Gemini            Leadership departure verification → [LEADERSHIP VERIFICATION] block
Step 4.6 GPT-4o-mini       Content formatter → restructures S1–S5 into clean numbered/bulleted text
Step 5   GPT-4o            Confidence audit → injects [[CF:type:note]] markers into text
Step 6   Deduplication     Sources deduped by URL
Step 7   buildHTML()       Assembles full HTML report with all panels
         Puppeteer         Generates PDF from HTML
         GitHub Actions    Commits slug.html + slug.pdf + reports/index.json
```

**Output schema (6 sections):**
- S1: Company Snapshot (revenue, margin trend, employees, India GCC, news, M&A, ownership, competitors)
- S2: Strategic Direction (vision, big initiatives, tech strategy)
- S3: Leadership & Org (key execs, changes, org structure, board)
- S4: Buying Signals & Pain Indicators (financial, tech, operational, hiring, timing triggers)
- S5: Competitive & Vendor Landscape (tech vendors, SI partners, procurement signals, competitive dynamics)
- S6: Sales Play (pitch angle, conversation openers, landmines, next step, best entry point)

**HTML report features (as of 3 June 2026):**
- Numbered section items with navy circles
- Inline confidence badges: `[Inferred]` (amber), `[Unverified]` (red), `[Assumed]` (grey), `[Outdated]` (blue)
- `[GAP FILL]` amber blocks — secondary research content
- `[LEADERSHIP VERIFICATION]` blue blocks — executive departure check result
- `[DEPARTED]` red blocks — confirmed executive departures
- Section-level source strips (📎 pill links at bottom of each card)
- Collapsible Confidence Notes panel (⚠️ purple — all flagged items listed)
- Collapsible Sources panel (📎 navy — all sources grouped by section)
- Leadership cards (person name, role, tenure, background)
- Ownership badge auto-detected from S1 content

**Key design decisions:**
- HTML report uses JS post-processing: orphan rebuilder → orphan mover → Sales Play formatter → ownership badge → leadership cards (setTimeout 50ms)
- formatContent() regex is case-insensitive — handles both ALL-CAPS and mixed-case Gemini headers
- PDF: `printBackground: false`, stripped backgrounds, left-border lines only, confidence panel hidden
- Company name canonicalized via OpenAI GPT-4o-mini before generation

---

## 7. DAILY BRIEF PIPELINE

**Trigger:** GitHub Actions cron 7AM IST daily, or manual `workflow_dispatch`

**Flow:**
```
scrape_daily.js:
  1. [Web Scraping Agent] Gemini × 6 sections with Google Search grounding
  2. [Synthesizing Agent] Claude gap check → fills gaps with targeted Gemini calls
  3. Saves research_cache.json (interim — not committed)

synthesize_daily.js:
  4. Reads research_cache.json
  5. [Synthesizing Agent] Claude × 5 calls — one per section → individual section JSON
  6. [Synthesizing Agent] Claude × 1 call → top_signals + regulatory JSON
  7. Assembles final report.json → committed to repo
```

**If synthesis fails:** Just re-run `node synthesize_daily.js` — no re-scraping needed.

**Known issue:** `synthesize_daily.js` intermittently fails with JSON parse error when Claude returns malformed JSON or truncates output (maxTokens: 1200 is tight). Fix deferred — increase maxTokens to 2000 and add retry logic.

**report.json schema (must match exactly — daily.html depends on this):**
```json
{
  "generated_at": "ISO timestamp",
  "generated_date": "1 June 2026",
  "top_signals": [ { "section", "headline", "summary", "severity", "so_what", "action", "sources" } ],
  "sections": {
    "macro":            { "title", "signals": [ { "headline", "summary", "severity", "so_what", "action", "sources" } ] },
    "competitive":      { "title", "signals": [] },
    "market_structure": { "title", "signals": [] },
    "client_verticals": { "title", "signals": [] },
    "partner_ecosystem":{ "title", "signals": [] }
  },
  "regulatory": {
    "last_updated": "date",
    "items": [ { "name", "region", "date", "status", "description" } ]
  }
}
```

**Critical rule for so_what:** Must ALWAYS name specific ITCI service line, vertical, platform, or geography. Never generic.

---

## 8. KNOWN ISSUES / TO-DO

- [ ] `synthesize_daily.js` intermittently fails with JSON parse error — increase maxTokens 1200→2000, add retry logic
- [ ] Render free tier spins down after inactivity — first request (company canonicalization) takes 50+ seconds
- [ ] PDF quality: backgrounds stripped via `@media print` — acceptable but not perfect
- [ ] Monthly report (`monthly.html`) is manually updated — no automation yet
- [ ] `generate_daily.js` is superseded — can be deleted
- [ ] `context.py`, `generate_report.py`, `requirements.txt` — old Python files, can be deleted
- [ ] Gemini RECITATION blocks handled with retry — working but adds latency

**Resolved in June 2026 session:**
- [x] formatContent() regex was ALL-CAPS only — fixed to case-insensitive `[A-Za-z]`
- [x] JS post-processor had same regex issue — fixed
- [x] Sales Play text blobs (join ' ') — fixed to join `<br><br>`
- [x] No .gitignore — created, protects .env and cache files
- [x] OPENAI_API_KEY missing from generate.yml — added
- [x] Confidence badges not matching (indexOf too strict) — 3-tier fallback matching added

---

## 9. ITCI COMPANY CONTEXT (for report prompts)

```
ITC Infotech — wholly-owned subsidiary of ITC Limited
HQ: Bengaluru | ~10,000 employees | ~$400M revenue
CEO: Manas Chakraborty (since Jan 2026)
Recent acquisition: BlazeClan Technologies (Apr 2024) — cloud/APAC

SERVICE LINES:
1. CIO 360 — App Modernization, ERP (S/4HANA), Infra, AI-RunOps
2. Industry 4.0 — Digital Twins, OT/IoT, Supply Chain, Gen AI
3. DxP — PLM: PTC Windchill, Windchill+, Codebeamer, FlexPLM, S-Series A&D
4. Cloud — CLOUDLYTICS/CSPM, Data Analytics, App Modernization

VERTICALS: CPG & Retail ~40%, Manufacturing ~25%, T&H ~15%, BFSI ~10%, A&D via DxP

COMPETITORS: TCS, Infosys, Wipro, HCLTech, Cognizant (Tier 1)
             LTIMindtree, Persistent, Coforge, Mphasis, TechM (Mid-tier)

KEY RISKS: PTC dependency (70-80% DxP revenue), mid-size squeeze, APAC competition
KEY OPPORTUNITIES: SAP ECC EOL 2027, Windchill→SaaS migration, EU AI Act compliance,
                   KSA e-invoicing Jul 2026, Middle East expansion
```

---

## 10. DESIGN PRINCIPLES (non-negotiable)

- **No Gemini/Claude/OpenAI brand names in UI** — use "Web Scraping Agent", "Synthesizing Agent", "Format Agent", "Audit Agent"
- **Color theme:** Navy (#1F3864) + Blue (#2E74B5). Monthly = blue, Daily = green (#1B4332), Account = blue
- **Home button:** Floating FAB bottom-left on all sub-pages (not in header — header space is precious)
- **Report list:** Reads from `reports/index.json` on GitHub Pages — permanent, shared across all users/devices
- **Account report:** Two-step UX — canonicalize name first (OpenAI) → show confirmation → then generate
- **Brutal honesty:** No softening of problems. Flag data risks explicitly. Check thought process before building.
- **Confidence transparency:** All low-confidence data must be visually tagged. Leadership must know what to verify before using in a conversation.

---

## 11. LOCAL COMMANDS

```bash
# Account report (test locally — requires .env with all 3 API keys)
node generate.js "IKEA"

# Daily brief (two steps)
node scrape_daily.js           # saves research_cache.json
node synthesize_daily.js       # saves report.json

# Render server (local test)
node server.js
```

**Note:** `.env` file does not exist in the repo. Create it manually with GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY before running locally.

---

## 12. APPROXIMATE COST PER ACCOUNT REPORT

| Step | Model | Purpose | Cost (approx) |
|------|-------|---------|---------------|
| Canonicalize | GPT-4o-mini | Company name | ~$0.001 |
| S1–S5 research | Gemini 2.5 Flash | Web scraping × 5 | ~$0.02–0.05 |
| Gap check | Claude Sonnet | Find missing data | ~$0.01 |
| Gap fills | Gemini 2.5 Flash | Fill gaps × 0–5 | ~$0–0.02 |
| S6 synthesis | Claude Sonnet | Sales play | ~$0.02 |
| Leadership verify | Gemini 2.5 Flash | Departure check | ~$0.005 |
| Content formatter | GPT-4o-mini | Structure text | ~$0.006 |
| Confidence audit | GPT-4o | Flag low-confidence | ~$0.02 |
| **Total** | | | **~$0.08–0.13** |

---

## 13. FUTURE ROADMAP (noted for later)

- **synthesize_daily.js fix** — increase maxTokens, add JSON retry logic
- **V2 ITC-specific account report** — pitch angles, rebadging angles, GDC hooks calibrated to ITCI service lines
- **Render upgrade** — eliminate cold-start delay ($7/month Starter plan or keep-alive cron)
- **Monthly report automation** — currently manual update only
- **PDF quality** — Puppeteer CSS improvements
- **Option B (JSON output)** — migrate Gemini section prompts to return structured JSON instead of free-form text, eliminating all formatting/parsing fragility

---

*Last updated: 3 June 2026. Re-upload after significant changes to keep Claude Code sessions in sync.*
