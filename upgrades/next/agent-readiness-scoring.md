<!-- bump: minor -->

## What Changed

Adds **agent-readiness scoring** — Salim Ismail's EXO 3.0 "task decomposition
matrix," made runnable. Score a task or workflow on its **coordination-vs-judgment
ratio** to tell whether it's a good agent candidate:

- **Coordination work** (routing, approvals, scheduling, status-tracking,
  prescriptive/standardized steps) is what agents do best → agent-ready.
- **Judgment work** (ambiguity, exceptions, relationships, no-playbook calls)
  → stays human.

New surface:

- `POST /agent-readiness/score` `{ "task": {description} }` or
  `{ "workflow": {steps:[...]} }` → `{ coordinationSignals, judgmentSignals,
  coordinationRatio, overallReadiness (0-100), recommendation, reason, matched }`.
  `recommendation` is `deploy-agent` (75+) / `agent-with-oversight` (55-74) /
  `hybrid` (40-54) / `human-led` (<40).
- A `/agent-readiness` skill so agents reach for it proactively before delegating
  work or deciding what to automate.

Deterministic + advisory — it answers a question, never blocks. Pairs with the
MTP Protocol's `/intent/org/test-action` (is it agent-ready AND does our purpose
endorse it?).

## Evidence

Three-tier coverage, all green, `tsc --noEmit` clean (0 errors):

- Unit — `AgentReadinessScorer.test.ts` (6): coordination-dominant → deploy-agent,
  judgment-dominant → human-led, mixed → hybrid, no-signal default, and a
  substring-false-match guard (log vs logical).
- Integration — `agent-readiness-routes.test.ts` (4): the route over the real
  HTTP pipeline (400 on neither task nor workflow; task + workflow scoring).
- E2E — `agent-readiness-lifecycle.test.ts` (3): boots a real server on a real
  port and confirms the feature is alive (200, not 404/503) end-to-end.

Skill registered in `installBuiltinSkills` (auto-installs for new + updated
agents, non-destructive); CLAUDE.md scaffold template documents the endpoint.
