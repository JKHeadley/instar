<!-- bump: patch -->
## What Changed

Adds the standing compaction canary for the Context Budget work (`src/monitoring/compactionCanary.ts`), run by the ContextBudgetSentinel: it counts every compaction Claude Code records in a topic session's transcript and checks that each one got both recovery artifacts (the PostCompact record and the SessionStart(compact) recovery block), reporting `n/a`, `uninitialized`, `accruing`, `diverged` or `healthy` per machine, engine and version. Adds the read route `GET /context-budget/sentinel` (the sentinel's status with the canary report; 503 while the sentinel is off, which is the default) and a CLAUDE.md Registry-First row pointing agents at it.

## What to Tell Your User

Nothing changes for you yet. Once it is switched on, I can show you whether my memory recovery after a conversation is compressed actually works on each machine, instead of assuming it.

## Summary of New Capabilities

- Standing compaction canary (transcript detection channel) and `GET /context-budget/sentinel`.

## Evidence

- Unit `tests/unit/compaction-canary.test.ts`; integration `tests/integration/context-budget-sentinel-route.test.ts`; e2e `tests/e2e/context-budget-canary-alive.test.ts`; migration `tests/unit/migrate-context-budget-sentinel-row.test.ts`.
