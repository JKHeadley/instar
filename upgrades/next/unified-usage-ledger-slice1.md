## What Changed
The first part of the unified usage ledger (spec: `docs/specs/unified-usage-ledger.md`).
- **New store.** `src/monitoring/UsageLedger.ts` keeps one row per Claude Code model request from this agent's own sessions in `.instar/server-data/usage-ledger.db`. Each row has fresh input, cache read, cache write and output as separate numbers, and "not reported" is kept apart from zero.
- **Only this agent's sessions.** A session counts when this agent started it (recorded when the session reports its id, wherever it runs), or when the transcript's own folder is inside this agent's home and not inside another agent's. Other agents and test folders on the same machine are no longer mixed in.
- **Attribution and totals.** Each row carries the topic, job, run and login of the session at the time of the request. Totals are kept by hour, day and conversation in the same database update as the rows.
- **Safe re-reading.** A per-file read position means nothing is counted twice when a file is re-read, pruned or resumed.
- **Dev-gated.** `usage.ledger.enabled` is on for development agents and off elsewhere. The existing token ledger, its pages and the runaway-usage alerts are unchanged.

## What to Tell Your User
Nothing changes for you yet. On development agents, I've started keeping a more accurate record of my own token use, labeled by conversation and job. The pages that show it come in a later update.

## Summary of New Capabilities
- Development agents record per-request token usage for their own Claude Code sessions, attributed to topic, job and login, with hourly, daily and per-conversation totals.

## Evidence
- `tests/unit/UsageLedger.test.ts`: 17 tests covering scope, attribution by request time, replay safety, depth and symlink limits, the shared scan budget, pruning and persistence.
- `tests/unit/devGatedFeatures-wiring.test.ts`: the new gate is live on a development agent and dark on the fleet.
- The session-manager and session-id bridge suites pass unchanged.
