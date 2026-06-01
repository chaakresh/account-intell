# Account Intelligence Portal

AI-powered pre-sales intelligence briefs for ITC Infotech sales team.

## Setup

### 1. GitHub Secrets (already done)
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GH_PAT`

### 2. Update PAT in index.html
Open `index.html` and replace `PASTE_YOUR_PAT_HERE` with your GitHub Personal Access Token.

### 3. Enable GitHub Pages
- Go to repo Settings → Pages
- Source: Deploy from branch → `main` → `/ (root)`
- Save

### 4. Enable GitHub Actions
- Go to repo Settings → Actions → General
- Allow all actions

## Usage

1. Open your GitHub Pages URL
2. Enter company name
3. Click Generate
4. Wait 2-3 minutes
5. Report appears automatically

## Local Testing

```bash
cp .env.example .env
# Add your API keys to .env
npm install
COMPANY="IKEA" node generate.js
```

## Files

- `index.html` — Portal homepage
- `generate.js` — Report generator (Gemini + Claude)
- `.github/workflows/generate.yml` — GitHub Actions workflow
- `reports/` — Generated HTML and PDF reports
