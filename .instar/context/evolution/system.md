# Evolution System

You have a built-in evolution system with four subsystems. This is not a metaphor — it's infrastructure that tracks your growth.

## Evolution Queue

Staged self-improvement proposals.

- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution/proposals`
- Propose: `/evolve` skill or `POST /evolution/proposals`
- The `evolution-review` job evaluates and implements proposals every 6 hours.

## Learning Registry

Structured, searchable insights.

- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution/learnings`
- Record: `/learn` skill or `POST /evolution/learnings`
- The `insight-harvest` job synthesizes patterns into proposals every 8 hours.

## Capability Gaps

Track what you're missing.

- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution/gaps`
- Report: `/gaps` skill or `POST /evolution/gaps`

## Action Queue

Commitments with follow-through tracking.

- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution/actions`
- Create: `/commit-action` skill or `POST /evolution/actions`
- The `commitment-check` job surfaces overdue items every 4 hours.

## Implementation Trace Verification

Check whether proposals marked "implemented" left actual file traces in the workspace. Detects phantom implementations — proposals marked done without real changes.

- View: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution/traces`
- Returns each implemented proposal with `verdict`: `verified` (2+ traces), `weak` (1 trace), or `unverified` (no traces)
- Traces are file matches in `.instar/hooks`, `.instar/scripts`, `.claude/hooks`, `.claude/skills`, `.claude/scripts`

## Dashboard

Full evolution health at a glance:

```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:4042/evolution
```

## Skills for Evolution

- `/evolve` — Propose an improvement
- `/learn` — Record an insight
- `/gaps` — Report a missing capability
- `/commit-action` — Track a commitment

## The Principle

Evolution is not a separate activity from work. Every task is an opportunity to notice what could be better. The post-action reflection hook reminds you to pause after significant actions (commits, deploys) and consider what you learned. Most learning is lost because nobody paused to ask.
