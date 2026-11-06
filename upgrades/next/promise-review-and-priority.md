## What Changed
Every promise an agent makes can now carry a priority: high when a person is waiting, normal for the agent's own work, low for nice-to-haves, or "not assessed yet". The agent's own review job looks over its open promises every six hours. It keeps each one, sets its priority, marks it done with proof, or archives it as superseded, duplicate or obsolete with a reason. Server-side rules refuse any closure that lacks its evidence, protect promises someone is waiting on, cap closures per run and per day, and log every decision. Any closure the review made can be undone for 30 days. High-priority promises now lead every new session's start-up context. The phone and dashboard Promises screens show priority, can filter by it, and count only open promises. The commitment sentinel no longer records one reply as two or three identical promises. Live on development agents, where closures start in a practice mode that only records them. Off on every other agent; an update adds no restriction to any existing agent.

## What to Tell Your User
Your agent now keeps its own promise list in order: it ranks what matters, closes what's done or no longer needed, and shows you the important ones first, so you never have to sort a long list yourself.

## Summary of New Capabilities
- Promises have a priority (high, normal, low), and you can filter by it on the phone and dashboard.
- The agent reviews its open promises on its own, closing finished or outdated ones with a written reason.
- Any promise the review closed can be reopened for 30 days.
- The most important open promises are the first thing every new session sees.

## Evidence
New tests across all three tiers: tests/unit/PromiseReview.test.ts (every review rule on both sides, caps, practice mode, race safety, reopen), tests/unit/promise-priority-surfaces.test.ts (phone counts and filter, dashboard sections and reopen, replication clamp, owner routing, CLAUDE.md and job template), tests/integration/promise-review-routes.test.ts through the real routes, and tests/e2e/promise-review-lifecycle.test.ts on the production init path (live on a development agent with closures in practice mode, dark on a fleet config). On 2026-11-06, Echo's own backlog went from 735 open promises to 197 in a hand-reviewed pass through the existing audited routes.
