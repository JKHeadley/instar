---
name: agent-readiness
description: Score a task or workflow on its coordination-vs-judgment ratio to tell whether it's a good agent candidate (EXO 3.0 task-decomposition matrix).
metadata:
  user_invocable: "true"
---

# /agent-readiness

Salim Ismail's EXO 3.0 diagnostic, made runnable: score a piece of work on its
**coordination-vs-judgment ratio**. Coordination work — routing information,
approvals, scheduling, status tracking, prescriptive/standardized steps — is what
AI agents do best, so it's *agent-ready*. Judgment work — resolving ambiguity,
handling exceptions, navigating relationships, making a call with no playbook —
should stay with (or escalate to) humans.

## When to use

- Before delegating a task/workflow to an agent — is it actually a good candidate?
- When deciding whether a process should be fully automated, agent-with-oversight,
  hybrid, or kept human-led.
- When mapping which of your workflows a small team + agents could rebuild first
  (Salim: "every task that scores high on coordination has agent readiness").

## How

Score a task:
```bash
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"task":{"name":"Invoice intake","description":"Route invoices, schedule approvals, track status, compile a weekly report, notify owners."}}' \
  http://localhost:${INSTAR_PORT:-4042}/agent-readiness/score
```

Score a workflow (by its steps):
```bash
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"workflow":{"steps":["Fetch the record","Assign accounts","Schedule orientation","Update the tracker"]}}' \
  http://localhost:${INSTAR_PORT:-4042}/agent-readiness/score
```

Returns:
```json
{
  "coordinationSignals": 5, "judgmentSignals": 0,
  "coordinationRatio": 1.0, "overallReadiness": 100,
  "recommendation": "deploy-agent",
  "reason": "...",
  "matched": { "coordination": ["route","schedule",...], "judgment": [] }
}
```

`recommendation` is one of: `deploy-agent` (75+), `agent-with-oversight` (55–74),
`hybrid` (40–54), `human-led` (<40). Deterministic + advisory — it answers a
question; it never blocks. Pair it with the MTP Protocol (`/intent/org/test-action`)
to check both "is this agent-ready?" and "does our purpose endorse it?"
