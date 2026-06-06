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

## What to Tell Your User

Your agent can now grade any task or workflow on whether it's a good fit for an agent at all. Ask it to "score this task for agent-readiness" and you get a 0-100 readiness score with a plain recommendation: hand it to an agent, agent-with-oversight, split it, or keep it human. The logic mirrors how EXO 3.0 thinks about delegation — coordination-heavy work (routing, scheduling, status-chasing) is agent-ready; judgment-heavy work (ambiguity, exceptions, relationships) stays with people. Useful the moment you're deciding what to automate next.

## Summary of New Capabilities

- `POST /agent-readiness/score` — score `{task}` or `{workflow}`; returns coordination/judgment signals, `overallReadiness` 0-100, and a `deploy-agent` / `agent-with-oversight` / `hybrid` / `human-led` recommendation. Deterministic + advisory, never blocks.
- `/agent-readiness` skill — the proactive entry point before delegating work or choosing what to automate.
- Pairs with `POST /intent/org/test-action`: is it agent-ready AND does the org's purpose endorse it?

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
