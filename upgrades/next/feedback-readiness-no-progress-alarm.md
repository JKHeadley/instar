# Feedback readiness: a sorter that stops without failing is announced once

## What Changed

Completes `docs/specs/feedback-factory-operating-drain.md` line 270 (expose progress age; no feature-local retry). The pause alarm (#2201) and the stall notice (#2202) both need runs that reach the sorting model. This adds a wall-clock check that does not:

- **`src/feedback-factory/drain/FeedbackDrainService.ts`**: `checkReadinessProgress()`, run by the canonical owner every `READINESS_PROGRESS_CHECK_INTERVAL_MS` (15 min). Once candidates have waited `READINESS_NO_PROGRESS_ALARM_MS` (6 h) with no successful readiness call, it raises ONE attention item per wait (`feedback-drain:readiness-no-progress:<since>`, "Feedback sorting has made no progress"). The item names the cause: no approved model, the drain not running, or runs that never ask the model. It is silent when the pause alarm or stall notice owns the episode, or the authority was revoked. Signal only.
- **`src/feedback-factory/drain/FeedbackDrainStore.ts`**: `readinessWaitingCount`, plus the durable `readiness_waiting_since` stamp. A successful call closes the wait.
- **`src/server/AgentServer.ts`**: the 15-minute timer, cleared on stop.
- **`src/server/routes.ts`**: `GET /feedback-factory/drain/status` → `readinessProgressAge` `{ waitingCandidates, waitingSince, ageMs, alarmAfterMs }`.
- **`src/scaffold/templates.ts` / `src/core/PostUpdateMigrator.ts`**: one awareness bullet after the stall-notice bullet, migrated idempotently.

## What to Tell Your User

If feedback sorting stops making progress for any reason, including the sorter never being asked at all, you now get one notice after about six hours. It says what is wrong in plain words. It only asks for your approval when no sorting model is approved; otherwise there is nothing for you to approve.

## Summary of New Capabilities

- `readinessProgressAge` on the drain status route.
- One deduped "Feedback sorting has made no progress" attention item per wait.

## Evidence

- `tests/unit/feedback-factory/drain-readiness-no-progress.test.ts` covers the bound edge (6 h minus 1 ms vs 6 h), ticks absent, ticks that never ask, no approved model, success closing the wait with a new item for a new wait, deferral to the pause and stall notices, and owner-only.
- `tests/unit/readiness-no-progress-awareness.test.ts` covers the template and the idempotent migration.
- `tests/integration/feedback-drain-readiness-brake.test.ts` and `tests/e2e/feedback-drain-readiness-brake.test.ts` check `readinessProgressAge` on the production status route.
