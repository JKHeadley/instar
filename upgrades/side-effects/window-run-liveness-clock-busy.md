# Side-Effects Review — window run liveness: heartbeat clock order + busy recovery

**Version / slug:** `window-run-liveness-clock-busy`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Bug topic 10000001008: the 48h run for topic 131439 was marked stalled while working. Two defects in `src/core/WindowRunLivenessAuthority.ts`:

1. `applySample` required `heartbeatMs <= nowMs`. The authority stamps `now` before the sample reads the transcript mtime, so a session writing during the sample has a heartbeat slightly in the future (65 ms in the incident) and read as not fresh. Now a heartbeat up to `WINDOW_RUN_HEARTBEAT_CLOCK_TOLERANCE_MS` (5 s) newer than `now` counts as fresh; beyond that it is still refused.
2. A `session-busy` refusal from `SessionRefresh` was mapped to `succeeded: false` and stalled the run. The production recover mapping moved into the exported helper `windowRunRecoveryResultFromRefresh`, which marks `session-busy` as `executorBusy: true`. The authority records outcome `executor-busy` (new union member), re-samples at once, and restores active on a green re-sample (transition reason `recovery-verified-executor-busy`); otherwise it stays at-risk, a later green tick restores active (the early promotion branch now accepts `executor-busy` like `succeeded`), and the existing recovery ceiling still fails it.

Tier 1: 2 src files + 1 test file, ~90 LOC, one review round. Reversible by revert.

## Decision-point inventory

- `heartbeat-fresh` predicate: accepts a slightly-future heartbeat (more permissive by ≤5 s).
- Recovery outcome classification: `session-busy` no longer stalls; it defers to re-sampling under the same ceiling.

## 1. Over-block

None added; both changes only remove false negatives.

## 2. Under-block

A genuinely wedged session that SessionRefresh still reports as busy (in-flight turn that never ends) is no longer stalled immediately; it stays at-risk (active already revoked) and fails at the 15-minute recovery ceiling. Active is never claimed without all five predicates green, so this cannot produce false-active, only a later terminal verdict. A clock 1–5 s fast on the heartbeat source is accepted as fresh; a larger skew is still refused.

## 3. Level-of-abstraction fit

Both fixes live in the authority that owns the predicates and the recovery lifecycle. The refresh-result mapping is a pure helper next to the type it produces, so the production wiring is unit-testable.

## 4. Signal vs authority compliance

The authority already holds the blocking decision (revoke active). The change makes its evidence reading correct; it adds no new brittle blocking check. Busy is a signal consumed under the existing ceiling, not a new gate.

## 5. Interactions

`routes.ts` W32 proof: `executor-busy` is neither `succeeded` nor a loud failure, so it does not count as recovery proof — correct. Exit proof `recoveryAttempts` still counts 1. The cadence executor reads only liveness status. No double recovery: the attempt object persists, so later ticks never call `recover` again.

## 6. External surfaces

`GET /window-run-liveness` can now show `recoveryAttempt.outcome: "executor-busy"` and the new transition reason. Fewer false "stalled" Telegram notices.

## 7. Multi-machine posture

Machine-local by design: the liveness authority evaluates the run on the machine that hosts its executor; no replicated state changes.

## 8. Rollback cost

Revert the PR. A persisted state file carrying `outcome: "executor-busy"` under the old code reads as neither succeeded nor pending, so the old code waits for the ceiling and fails — safe.

## Second-pass review

(appended below)

**Reviewer (independent subagent, 2026-10-27 22:29 PDT):** Checked that neither path back to active can skip a green five-predicate sample; the single recovery attempt is persisted before actuation so a busy refusal never causes a second attempt; the ceiling is never extended; `routes.ts` W32 proof cannot count `executor-busy` as success (and a later failure still counts as loud); exit proof stays honest (`recoveryAttempts` 1, `recoveryTaskMatched` false); old code reading a persisted `executor-busy` waits for the ceiling and fails safely; 5 s tolerance is reasonable for a same-machine file timestamp. Minor: a later green tick after a busy attempt logs the generic `recovery-verified` reason. **Concur with the review.**
