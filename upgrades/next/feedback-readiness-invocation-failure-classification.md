# Feedback readiness: a provider failure never pauses the sorter; the error names its cause; a long stall is announced once

## What Changed

Three fixes rooted in `docs/specs/feedback-factory-operating-drain.md` (lines 121 and 270), after the live 2026-10-14 incident on the Mac Studio in which eight HTTP 429s on the approved model's lane (drain_audit rows 2042, 2045–2051) demoted the readiness authority for four days:

- **`src/feedback-factory/drain/FeedbackDrainService.ts`** — the three-strike demotion (`readiness-authority-repeated-invocation-failure`) is gone. A tick with no usable answer (timeout, provider error, rate limit, rejected answer) is counted (`recordAuthorityTransientFailure`) and exposed; only the spec's closed list demotes (`ReadinessContractViolation` at once, the spend brake). After `READINESS_STALL_NOTICE_TICKS` (6) failed ticks in a row the service raises ONE attention item per stall episode (`feedback-drain:readiness-stalled:<authority>:<generation>:<since>`, "Feedback sorting is not making progress"), naming the last failure and saying nothing is paused. No retry out of cadence is added (line 270).
- **`src/feedback-factory/drain/FeedbackDrainStore.ts`** — the counter now opens a stall episode (`authority_readiness_stall_since`) on its first strike and stamps `authority_readiness_last_success_at` on clear; `readinessProgress(authorityId, generation)` returns `{ consecutiveFailedTicks, stalledSince, lastSuccessAt }`.
- **`src/server/routes.ts`** — `GET /feedback-factory/drain/status` carries `readinessProgress` beside `lastReadinessFailure`.
- **`src/core/CodexCliIntelligenceProvider.ts`** — in exec --json mode the thrown Error for a non-zero exit now carries the LAST `error` / `turn.failed` message from the stdout event stream (bounded to 240 chars, secret-scrubbed) after the stderr tail. The parser's pre-filter admits those two event types; `agent_message` / `turn.completed` handling is unchanged.
- **`src/scaffold/templates.ts` / `src/core/PostUpdateMigrator.ts`** — the readiness brake wording is narrowed (no more "three runs in a row"), the status sentence names `readinessProgress`, and a new stall-notice bullet sits right after the pause-alarm bullet; all three migrate idempotently to existing agents.

## What to Tell Your User

If the model that sorts feedback reports is rate-limited or times out for a while, sorting no longer switches itself off. Each failed attempt is retried at the next scheduled run, and if that goes on for about three hours you get one notice saying sorting is not making progress and naming the error. Nothing needs your approval for that; it clears on its own when the model answers again. The brakes that do need your dashboard approval are unchanged: the spend cap, a different model answering, or an answer that breaks the rules. If the sorter is currently paused by the old rule, approve it once on the dashboard; that rule cannot trip again.

## Summary of New Capabilities

- Readiness progress age on the drain status route: failed runs in a row, since when, last success.
- One deduped "not making progress" attention item per stall episode.
- Codex exec --json failures carry their real cause (for example a 429) in the error text.

## Evidence

- `tests/unit/feedback-factory/drain-readiness-pause-alarm.test.ts` — never pauses; one stall notice after six ticks; dedup; new episode after a success.
- `tests/unit/feedback-factory/drain-readiness-brake.test.ts`, `tests/unit/feedback-factory/drain-readiness-chunking.test.ts`, `tests/integration/feedback-factory-drain-service.test.ts` — runs of invocation failures count and never demote; contract violations still demote at once.
- `tests/unit/feedback-drain-store.test.ts` — the counter, episode start and last-success stamps.
- `tests/integration/feedback-drain-readiness-brake.test.ts`, `tests/e2e/feedback-drain-readiness-brake.test.ts` — `readinessProgress` on the production status route.
- `tests/unit/codex-cli-provider-execjson.test.ts` — the carried, bounded last-event message.
- `tests/unit/readiness-stall-notice-awareness.test.ts` — template bullet, wording migrations, idempotency.
- Live: drain_audit rows 2042–2052 and `~/.codex/sessions/2026/10/14` rollouts on the Mac Studio; ACT-114.
