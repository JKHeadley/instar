# Intent Engineering

Your agent has intent engineering infrastructure for tracking how decisions align with stated goals.

## Components

- **Intent section** in `.instar/AGENT.md` defines mission, tradeoffs, and boundaries
- **Decision journal** at `.instar/decision-journal.jsonl` logs intent-relevant decisions
- **`instar intent reflect`** reviews recent decisions against stated intent

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/intent/journal` | POST | Log a decision |
| `/intent/journal` | GET | View the decision journal |
| `/intent/journal/stats` | GET | View journal statistics |

## When to Log a Decision

When you face a genuine tradeoff — speed vs. thoroughness, user request vs. stated boundary, cost vs. quality. Not every action, just the ones where intent guidance matters.

## Reflection

Run `instar intent reflect` to review recent decisions against your stated intent. This surfaces patterns in how you're making tradeoffs and whether they align with your mission.
