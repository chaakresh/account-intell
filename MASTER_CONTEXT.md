# ITC Infotech Intelligence Portal — Master Context
**File:** MASTER_CONTEXT.md
**Created:** June 2026
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
- **OpenAI GPT-4o-mini** (via HTTPS) — company name canonicalization only
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
| `generate.js` | Account report generator (Gemini research + Claude synthesis + PDF) |
| `scrape_daily.js` | Daily brief — Step 1: Gemini scrapes 6 sections, gap check/fill, saves `research_cache.json` |
| `synthesize_daily.js` | Daily brief — Step 2: reads cache, Claude synthesizes per section, saves `report.json` |
| `generate_daily.js` | Old combined daily script — **ignore, superseded** |
| `server.js` | Render server — `/canonicalize` (OpenAI) + `/generate` (GitHub dispatch) |
| `package.json` | Node dependencies |
| `.env` | Local API keys (never committed) |
| `research_cache.json` | Interim scraping output (daily brief pipeline) — not committed |
| `report.json` | Daily brief output — committed daily by GitHub Actions |
| `reports/index.json` | Persistent list of all generated account reports with timestamps |

### GitHub Actions workflows
| File | Trigger | What it does |
|------|---------|-------------|
| `.github/workflows/generate.yml` | `workflow_dispatch` (from portal) | Runs `generate.js`, generates HTML + PDF, updates `reports/index.json` |
| `.github/workflows/daily_report.yml` | Cron `30 1 * * *` (7AM IST) + manual | Runs `scrape_daily.js` then `synthesize_daily.js`, commits `report.json` |

---

## 5. ENVIRONMENT VARIABLES

### Local `.env`
```
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
```

### Render Environment Variables
```
GH_PAT=...              — GitHub Personal Access Token (repo + workflow scopes)
OPENAI_API_KEY=...      — GPT-4o-mini for canonicalization
```

### GitHub Secrets (in account-intell repo)
```
GEMINI_API_KEY
ANTHROPIC_API_KEY
GH_PAT
```

---

## 6. ACCOUNT REPORT PIPELINE (`generate.js`)

**Trigger:** User types company name in `account.html` → Render server → GitHub Actions

**Flow:**
```
1. [Web Scraping Agent] Gemini × 5 calls → Sections 1-5 + sources
2. [Synthesizing Agent] Claude gap check → JSON list of gaps (max 5)
3. [Web Scraping Agent] Gemini × N targeted fills → appended to weak sections
4. [Synthesizing Agent] Claude synthesis → Section 6 (Sales Play)
5. Puppeteer → PDF from HTML
6. GitHub Actions → reports/slug.html + reports/slug.pdf + reports/index.json committed
```

**Output schema (6 sections):**
- S1: Company Snapshot (revenue, margin trend, employees, India GCC, news, M&A, ownership, competitors)
- S2: Strategic Direction (vision, big initiatives, tech strategy)
- S3: Leadership & Org (key execs, changes, org structure, board)
- S4: Buying Signals & Pain Indicators (financial, tech, operational, hiring, timing triggers)
- S5: Competitive & Vendor Landscape (tech vendors, SI partners, procurement signals, competitive dynamics)
- S6: Sales Play (pitch angle, conversation openers, landmines, next step, best entry point)

**Key design decisions:**
- HTML report uses JS post-processing to fix orphan content, group leadership into person cards, parse Section 6 into styled blocks
- Execution order: rebuild flat sections → move orphan siblings → Sales Play fix → Leadership grouping (setTimeout 50ms)
- PDF: `printBackground: false`, stripped backgrounds, left-border lines only
- Company name canonicalized via OpenAI before generation (apple → Apple Inc.)

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

- [ ] `synthesize_daily.js` intermittently fails with JSON parse error (Claude returns malformed JSON) — needs more robust JSON extraction or retry logic
- [ ] Gemini RECITATION blocks handled with retry — working but adds latency
- [ ] Render free tier spins down after inactivity — first request takes 50+ seconds
- [ ] PDF quality: backgrounds stripped via `@media print` — acceptable but not perfect
- [ ] Monthly report (`monthly.html`) is manually updated — no automation yet
- [ ] `generate_daily.js` is superseded by the two-script approach — can be deleted
- [ ] `context.py`, `generate_report.py`, `requirements.txt` — old Python files, can be deleted

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

- **No Gemini/Claude brand names in UI** — use "Web Scraping Agent" and "Synthesizing Agent"
- **Color theme:** Navy (#1F3864) + Blue (#2E74B5). Monthly = blue, Daily = green (#1B4332), Account = blue
- **Home button:** Floating FAB bottom-left on all sub-pages (not in header — header space is precious)
- **Report list:** Reads from `reports/index.json` on GitHub Pages — permanent, shared across all users/devices
- **Account report:** Two-step UX — canonicalize name first (OpenAI) → show confirmation → then generate
- **Brutal honesty:** No softening of problems. Flag data risks explicitly. Check thought process before building.

---

## 11. LOCAL COMMANDS

```bash
# Account report (test locally)
cd account-intell
node generate.js "IKEA"

# Daily brief (two steps)
node scrape_daily.js           # saves research_cache.json
node synthesize_daily.js       # saves report.json

# Render server (local test)
node server.js
```

---

## 12. FUTURE ROADMAP (noted for later)

- **V2 ITC-specific account report** — pitch angles, rebadging angles, GDC hooks calibrated to ITCI service lines
- **Gemini consistency fix** — run each section prompt twice, take longer response
- **Monthly report automation** — currently manual update only
- **Render upgrade** — eliminate cold-start delay for production use
- **PDF quality** — Puppeteer CSS improvements

---

*Context file created: June 2026. Update and re-upload after significant changes to keep Claude Code sessions in sync.*
