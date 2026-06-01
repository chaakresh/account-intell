import anthropic
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo
from context import ITC_INFOTECH_CONTEXT


def build_prompt():
    today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%B %d, %Y")

    return f"""You are an expert IT industry analyst. Today's date is {today}.

Generate a daily intelligence brief for ITC Infotech's CEO and leadership team.
Search the web for today's most relevant news across 6 topic areas below.

ITC INFOTECH CONTEXT — use this to make every "so_what" brutally specific:
{ITC_INFOTECH_CONTEXT}

SEARCH AND ANALYSE THESE 6 AREAS. For each, find the 3 most important signals today.

SECTION 1 — MACRO & IT SERVICES
Search: IT services industry news today, AI disruption IT outsourcing, global IT spending trends,
PLM market news, enterprise software market shifts

SECTION 2 — COMPETITIVE INTELLIGENCE
Search: TCS Infosys Wipro HCL Cognizant news today, LTIMindtree Persistent Coforge Mphasis
Tech Mahindra announcements, Indian IT sector deal wins contracts today

SECTION 3 — MARKET STRUCTURE SHIFTS
Search: AI companies entering IT services (Anthropic OpenAI Google Mistral), hyperscalers
AWS Azure GCP direct IT services expansion, competitor partnership alliance announcements today
(e.g. Infosys OpenAI partnership, TCS Microsoft deal), non-traditional IT services entrants

SECTION 4 — CLIENT VERTICALS
Search: CPG retail technology digital transformation news today, manufacturing Industry 4.0
automation news, hospitality travel technology news, BFSI banking fintech IT news,
aerospace defense technology news

SECTION 5 — PARTNER ECOSYSTEM
Search: PTC Windchill PLM news announcements today, SAP S4HANA news today,
Adobe enterprise news, ServiceNow New Relic platform news, enterprise software
vendor strategy changes

SECTION 6 — REGULATORY & GEOPOLITICAL
Search: EU AI Act compliance technology news, data privacy regulations IT services,
outsourcing regulations US Europe India, KSA Saudi Arabia technology mandate,
DORA compliance financial technology

SEVERITY GUIDE:
- red: Act within days — direct threat or time-sensitive opportunity
- amber: Monitor — developing situation, review this week
- green: Awareness only — no immediate action needed

CRITICAL RULES FOR "so_what":
- NEVER write generic statements like "may impact IT services"
- ALWAYS name the specific ITC Infotech service line, vertical, platform, or geography affected
- Example GOOD: "PTC's new pricing directly compresses DxP margins on Windchill renewal deals in Americas"
- Example BAD: "This could affect ITC Infotech's business"

OUTPUT: Return ONLY a valid JSON object. No markdown. No code blocks. No explanation. Raw JSON only.

{{
  "generated_at": "{datetime.now(ZoneInfo('Asia/Kolkata')).isoformat()}",
  "generated_date": "{today}",
  "top_signals": [
    {{
      "section": "Section name e.g. Competitive Intelligence",
      "headline": "Concise headline max 12 words",
      "summary": "2 sentences. What happened and why it matters.",
      "severity": "red",
      "so_what": "1 sentence — name specific ITCI service line or vertical affected",
      "sources": [
        {{"name": "Publication name", "url": "https://actual-article-url.com"}}
      ]
    }}
  ],
  "sections": {{
    "macro": {{
      "title": "Macro & IT Services",
      "signals": [
        {{
          "headline": "Neutral, factual headline max 12 words",
          "summary": "Verified fact — 2 sentences. What happened and why it matters. Keep only claims supported by sources.",
          "severity": "red|amber|green",
          "so_what": "Business implication — 1 sentence on why it matters to ITCI. Name specific service line, vertical, or geography.",
          "action": "Recommended action — 1 sentence. Calm, specific next step. Use high priority / watch closely / prepare now language, not panic language.",
          "sources": [
            {{"name": "Publication name", "url": "https://actual-article-url.com"}}
          ]
        }}
      ]
    }},
    "competitive": {{
      "title": "Competitive Intelligence",
      "signals": []
    }},
    "market_structure": {{
      "title": "Market Structure Shifts",
      "signals": []
    }},
    "client_verticals": {{
      "title": "Client Verticals",
      "signals": []
    }},
    "partner_ecosystem": {{
      "title": "Partner & Ecosystem",
      "signals": []
    }}
  }},
  "regulatory": {{
    "last_updated": "{today}",
    "items": [
      {{
        "name": "Regulation or policy name",
        "region": "Geography",
        "date": "Deadline or effective date",
        "status": "active|upcoming|building",
        "description": "2 sentences: what it is and specific ITCI implication"
      }}
    ]
  }}
}}

top_signals: Pick the 3-5 most critical signals across ALL sections.
Each section signals array: exactly 3 signals.
regulatory items: 3-5 most relevant regulatory items for ITCI geographies.
"""


def generate_report():
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    ist = ZoneInfo("Asia/Kolkata")
    print(f"[{datetime.now(ist).strftime('%Y-%m-%d %H:%M IST')}] Generating daily report...")

    response = client.messages.create(
        model="claude-opus-4-6-20250514",
        max_tokens=4000,
        tools=[{
            "type": "web_search_20250305",
            "name": "web_search"
        }],
        messages=[{
            "role": "user",
            "content": build_prompt()
        }]
    )

    # Extract JSON from response
    report_json = None
    for block in response.content:
        if block.type == "text":
            text = block.text.strip()
            # Strip markdown fences if Claude added them
            if "```" in text:
                parts = text.split("```")
                for part in parts:
                    if part.strip().startswith("{"):
                        text = part.strip()
                        break
            # Find JSON object
            start = text.find("{")
            end = text.rfind("}") + 1
            if start != -1 and end > start:
                try:
                    report_json = json.loads(text[start:end])
                    break
                except json.JSONDecodeError as e:
                    print(f"JSON parse error: {e}")
                    continue

    if not report_json:
        raise ValueError("Failed to extract valid JSON from Claude API response")

    # Save report.json at repo root
    output_path = "report.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report_json, f, indent=2, ensure_ascii=False)

    top_count = len(report_json.get("top_signals", []))
    print(f"Report saved to {output_path}. Top signals: {top_count}")
    return report_json


if __name__ == "__main__":
    generate_report()
