# Side-Effects Review — a deferred restart pauses new local verifies, and closed PRs are skipped

**Version / slug:** `lv-restart-gap-and-closed-skip`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (small, reversible): 3 source files (`src/localVerify/localVerifyWiring.ts`, `src/localVerify/LocalVerifyService.ts`, `src/localVerify/localVerifyRoutes.ts`), 2 test files, ~50 LOC of source. Effort: one build round, one test adjustment, first commit attempt. The AutoUpdater itself is NOT changed.

**Defect 1 — root cause.** `updatePendingFromAutoUpdater` decided "update pending" from `pendingUpdate != null || coalescingUntil is a time`. `AutoUpdater.applyPendingUpdate()` sets `pendingUpdate = null` (and `pendingUpdateDetectedAt = null`) immediately after a successful install, BEFORE `gatedRestart()` checks the restart holds. So for the whole time the restart was deferred by the `local-verify` hold, the verifier saw `pending: false`, `decideUpdatePause` returned false, and `pump()` started the next queued run seconds after each finished; every 300 s retry found a run in flight. Evidence: `logs/server.log` 2026-10-25T08:50:12Z … 09:15:21Z `Restart deferred for v1.3.1429: held for in-flight work: a local verify of PR #2194 …` → `PR #2183` → `main`, and `state/auto-updater.json` at 09:15Z: `pendingUpdate: null`, `restartDeferral.active: true`, `currentBlockers: ["local-verify:main"]`. Fix: an active `restartDeferral` also counts as pending; `pendingSinceMs` is the earlier of `pendingUpdateDetectedAt` and `restartDeferral.firstDeferredAt` so the existing 120-min cap counts the whole wait. `otherBlockers` is unchanged (any non-`hold:local-verify` blocker, or unknown blockers, still means "never pause").

**Defect 2.** `request()` now asks `seams.isPrOpen(pr)` after `prView`; a definite `false` answers `{ ok: false, code: 'pr-closed' }` (HTTP 409) with a `refused` audit (`reason: pr-closed`) and drops any queued entry for that PR (`dequeued`, `reason: closed`; a run in flight is not cancelled). At pick time, the existing pre-start re-read (`refreshBaseThenPump`, triggered by `decideBaseRefresh`: waited ≥ 5 min or `main` moved) now also asks `isPrOpen` in parallel with `baseHead`; a definite `false` splices the entry with a `dequeued` audit (`reason: closed`) and pumps. `null`/throw keeps the entry. The pre-start step no longer requires a `baseHead` seam (without one the base stays as resolved). Fresh entries (base resolved < 5 min ago, which includes the open check at request time) still start synchronously.

## Decision-point inventory

- `updatePendingFromAutoUpdater` (rule (b) input) — **modify** — one more condition makes `pending` true; `decideUpdatePause` unchanged.
- `LocalVerifyService.request` admission — **modify** — refuses a definitely-closed PR.
- `LocalVerifyService.refreshBaseThenPump` — **modify** — drops a definitely-closed entry before start.
- `statusForResult` — **modify** — `pr-closed` → 409.
- AutoUpdater restart hold/deferral — **pass-through** — unchanged; still the authority on when to restart.

## 1. Over-block

Rule (b) pausing more often: it pauses only while a restart is actually deferred AND the only blockers are local-verify holds; that is exactly the case the rule was written for. A stale persisted `restartDeferral.active` (crash between deferral and restart) would pause starts until the AutoUpdater's first tick clears it (`!updateAvailable` → `clearRestartDeferral`) or the 120-min cap from `firstDeferredAt` lapses; the deferral is cleared before every successful restart request, so this needs a crash in that window. Closed-PR checks: only a definite `false` from `gh pr view --json state` (state !== OPEN) refuses/drops; a draft PR is `OPEN` and is not affected.

## 2. Under-block

A PR closed less than 5 minutes after its last base/open read, with no request arriving in between, still starts (the pick-time check rides the pre-start re-read window); the existing in-flight path and records handle that, as before. A deferral whose blockers include sessions (non-`restartImmediately` agents) still never pauses — by design (`otherBlockers`).

## 3. Level-of-abstraction fit

The fix sits in the adapter that translates AutoUpdater state into the verifier's pause input — the right layer; the AutoUpdater's own semantics (`pendingUpdate` = "not yet applied") are left intact. The open check reuses the existing `isPrOpen` seam the restore path uses, and the existing pre-start async step.

## 4. Signal vs authority compliance

No new blocking authority over agent behaviour or messages. Both changes only decide whether the verifier spends a run; deterministic inputs (a durable boolean, GitHub PR state); unknown never blocks.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added; deterministic floors only.

## 5. Interactions

- Rule (b) pause and the verifier-changed hold (#2340) both stop starts; independent, both release on restart.
- `restartHolds()` reports only the in-flight run, so a paused service never holds the restart it waits for (verified through the real AutoUpdater in the new test: the retry writes `restart-requested.json`).
- Merge hand-off hold (#2334): unaffected; `refreshBaseThenPump` still ends in `pump()`.
- Starved clock: paused time already subtracts (`pausedMs`), so pausing during a deferral cannot raise a false "starved" alarm.
- One extra `gh pr view --json state` call per POST and per pre-start re-read (≤ 1 per run start).

## 6. External surfaces

`POST /local-verify` gains a 409 `pr-closed` answer (previously such PRs were queued). Callers that treat non-2xx as "not queued" are correct. The merge watcher's automatic requests go through the same `request()`; a closed PR not being queued is the intended outcome.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface changes; the audit log gains two reasons.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the verifier runs only on the lease holder and the AutoUpdater/restart state is per machine; each machine's verifier reads its own AutoUpdater.

## 8. Rollback cost

Revert the commit; no persisted shape changes, no migration.

## Conclusion

Two narrow input fixes to existing rules; the 5 original new tests fail on the previous code (a 6th covers the reviewer's point) and pass with it; 413/413 local-verify unit, integration (10) and e2e (8) local-verify tests pass. Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude), 2026-10-25
**Independent read of the artifact: concur**

Verified against the code: `applyPendingUpdate()` nulls `pendingUpdate`/`pendingUpdateDetectedAt` before `gatedRestart()` records the hold deferral, so the old adapter saw `pending:false` exactly while the restart waited on us. No deadlock: `restartHolds()` reports only a live in-flight run, so a paused service contributes no hold; `getRestartBlockers()` names our hold `hold:local-verify:*`, which `otherBlockers` excludes, and any session/foreign hold still un-pauses. A stale persisted `restartDeferral.active` is bounded by the first tick (10 s after start, `!updateAvailable` → `clearRestartDeferral`) and the 120-min cap from `firstDeferredAt`; `gatedRestart` clears it before every restart request. Async pre-start: `this.starting` blocks re-entrant pumps; after the await `stopped` is checked, a concurrent request that replaced the entry makes `queue.includes(entry)` false (no wrong drop), and `pump()` persists the splice. `request()`'s `pr-closed` check runs before the in-flight branch, so a closed in-flight PR answers 409 while its run continues — harmless. Minor, non-blocking: a `pr-closed` refusal does not drop an already-queued entry for that PR; one picked < 5 min after its last base read starts without an open check (already disclosed in §2 as the under-block window). Signal-vs-authority: no new authority; unknown never blocks. Ran `npx vitest run tests/unit/localVerify/`: 16 files, 412/412 pass.

**Author's response (same turn):** the minor point is closed in this PR, not deferred — `request()` now drops the queued entry for a PR it refuses with `pr-closed` (audited `dequeued`, `reason: closed`; a run in flight is left to finish), with a new unit case; 413/413 after.

## Evidence pointers

- `tests/unit/localVerify/LocalVerifyService.test.ts` — "a deferred restart is a pending update" (2 cases, one through the real AutoUpdater), "closed PRs are skipped" (3 cases); the existing 120-min test gained one `flush()` (its entry now takes the async pre-start step after > 5 min).
- `tests/unit/localVerify/localVerifyRoutes.test.ts` — `pr-closed` → 409.
- Live: `logs/server.log` 2026-10-25T08:50Z–09:15Z deferral lines; `state/auto-updater.json` snapshot above.

## Class-Closure Declaration (display-only mirror)

Class: "a rule reads a state field that is cleared one step before the state it is meant to cover". Consumers of the AutoUpdater's `pendingUpdate` outside the AutoUpdater: this adapter (fixed); `src/server/routes.ts` (status display only, no decision); `src/feedback-factory/execute/buildFeedbackExecutor.ts` `executorUpdatePending` — examined, deliberately NOT changed: its brake exists so an executor attempt is not started just before an imminent restart, it holds no restart of its own, and counting a deferral (which on non-`restartImmediately` agents can be held by sessions for hours) would refuse attempts for hours without shortening any restart. Self-action note: no new self-triggered action; the change removes runs.
