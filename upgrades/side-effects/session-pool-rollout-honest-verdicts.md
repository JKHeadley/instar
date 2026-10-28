# Side-Effects Review — session-pool rollout: honest verdicts, no stale-red flap, queue decoupled from stage

**Version / slug:** `session-pool-rollout-honest-verdicts`
**Date:** `2026-10-28`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Commitment CMT-1117 (feature maturation review 2026-10-28). Evidence: 25 of 29 reds in `.instar/session-pool-e2e-results.json` today were runs where vitest's globalSetup refused with `INSTAR_TEST_CAPACITY_TIMEOUT` (the failover E2E never started); `server.log` shows 69 `stage-advanced` / 69 `stage-reverted` pairs.

Four changes:

1. `src/core/sessionPoolFailoverCheck.ts` — the verdict mapping gains an INCONCLUSIVE row: exit 75 (EX_TEMPFAIL), or a run whose vitest JSON report is missing or shows zero executed tests and zero failed suites, throws, so `SessionPoolFailoverRunner` records nothing. New pure `parseVitestJsonReport`. The exit code alone cannot carry this: vitest overwrites the semaphore's 75 with 1 when globalSetup throws (`cli-api` `startVitest` catch), which is how the reds were recorded. Verified against vitest 2.1.9 with throwaway configs: a throwing globalSetup exits 1 and writes a report with 0 executed tests and 0 failed suites (→ inconclusive); a throwing `beforeAll` exits 1 with 0 executed tests and 2 failed suites (→ red).
2. `src/commands/server.ts` `runProcess` — adds `--reporter=json --outputFile.json=<logs>/session-pool-failover-runner.report.json`, removes the previous report before each run, rejects a report older than the spawn, and passes `testReport` on close.
3. `src/core/StageAdvancer.ts` `reconcile()` — a current-commit red at the current stage is SUPERSEDED (no revert, `stage-revert-superseded` audit) when the latest verified result at the prior stage is a green for the same commit recorded AFTER the red. That green is exactly what `advanceTo` promoted on. Without this, the runner records each run against the stage running at the time, so after a revert the higher stage's latest row stays the old red, and every advance was reverted by the next reconcile (the flap). Adds read-only `currentStage()`.
4. `src/core/SessionPoolRolloutDriver.ts` — logs `rollout-advanced` only when `currentStage()` reads back the target; otherwise `rollout-advance-not-applied` and `advanceSkippedReason: 'not-applied'`.
5. `src/core/testRunnerRunClassifier.ts` — `--outputFile` / `--outputFile.json` join the safe value-taking flags. Without this the new flag made the runner's one-file E2E classify as a full suite, so it would wait for the single full-suite slot and hit capacity timeouts more often (found when the flag check itself stalled behind a suite holder). The flag only names where a reporter writes; it never changes which tests run.
6. Inbound queue: new `inboundQueuePoolGateOpen(cfg)` (`cfg.enabled === true`) in `inboundQueueConfig.ts`. Both the boot sweep's `queueWillRun` and the engine construction gate use it instead of `stage !== 'dark'`.

Tier 1 (declared): every piece is reverted by a code revert; no data or config migration. Size: 6 src files, ~150 LOC src, tests in 5 files. Proportion: one implementation pass, no spec review rounds (Tier 1).

## Decision-point inventory

- Failover verdict mapping (`makeSubprocessFailoverCheck`) — modify — adds an inconclusive (record-nothing) outcome; never produces a new green or red.
- `StageAdvancer.reconcile` revert decision — modify — one new no-revert case, narrowly bounded (same commit, verified, strictly newer prior-stage green).
- Rollout driver audit line — modify — logging/return value only; no new write.
- Test-runner lane classification — modify — one reporting flag stops disqualifying a targeted run; which files run is still decided by the matched-file-set check.
- Inbound-queue construction + boot-sweep gate — modify — gate input changes from pool stage to pool enabled.

---

## 1. Over-block

The inconclusive row could swallow a genuine failover failure only if that failure produces no executed test AND no failed suite in the report: e.g. vitest crashing before it writes the report for a reason inside the E2E. A failing test, a throwing `beforeAll`, or an import error in the E2E file all appear in the report (failed tests or `numFailedTestSuites`) and still record red. Recording nothing is the safe direction for promotion: no green can be recorded from such a run either, so the stage cannot climb on it.

## 2. Under-block

- If the JSON report writer itself breaks (a vitest upgrade renames fields), every run becomes inconclusive: no promotion and no demotion. That freezes the stage where it is instead of producing wrong verdicts; the failover-runner audit line (`check-threw` with the inconclusive message) makes it visible.
- The supersede rule trusts the prior-stage green as much as `advanceTo` already does. A real regression at the higher stage is only re-detected when the runner next runs at that stage (≤1 tick interval, default 1h), and re-promotion to that stage is capped at two verified reds per build (`MAX_TARGET_REDS_PER_COMMIT`).

## 3. Level-of-abstraction fit

Right layers: the verdict honesty lives in the one module that maps a subprocess outcome to green/red (its doc already defines the throw-means-record-nothing contract); the flap fix lives in the only revert decision; the queue gate lives beside the existing shared stage resolver in `inboundQueueConfig.ts`. No parallel gate is added.

## 4. Signal vs authority compliance

No new authority. The check gains a third outcome that removes evidence rather than creating it. `reconcile` gains one case where it does NOT act. The driver change is audit-only. The queue gate change lets an already-graduated feature keep running; it grants the queue no new authority (its custody paths on the router still gate on the live stage).

## 4b. Judgment-point check

None. All rules are deterministic facts (exit code, report counts, timestamps, signatures).

## 5. Interactions

- `SessionPoolFailoverRunner` already treats a throwing check as "record nothing" (existing contract, unchanged).
- The separate revert-only reconcile tick and the driver both call `reconcile()`, so both get the flap fix.
- Queue at stage dark: the router's queue paths (`ordering-behind-queued`, router `queueMessage`) only run when `_sessionPoolStage() !== 'dark'`, unchanged. At dark the engine takes custody only on `admission-refused` (overload deferral), which previously fell back to "please resend". It also drains what it already holds instead of the boot sweep expiring it as `pool-dark`. `SpawnAdmission`'s live-owner arm still gates on stage dark (unchanged).
- At stage dark the drain's egress also stays on this machine: `_drainLocalDeliver` skips `route()` and `forceReplace` refuses (second-pass fix, see below).
- The `/guards` row for `holdForStability` reads `_inboundQueue !== null`; it now reads on when the queue runs at dark, which is accurate.

## 6. External surfaces

New audit events: `stage-revert-superseded`, `rollout-advance-not-applied`. New file `.instar/logs/session-pool-failover-runner.report.json` (overwritten each run). Fewer user-facing loss notices (no `pool-dark` expiry after a demotion). No route or config changes.

## 7. Multi-machine posture

Machine-local by design: each machine runs its own failover runner, holds its own stage config and its own durable inbound queue (as before). The verdict store is per-machine. Nothing new crosses machines.

## 8. Rollback cost

Code revert and release. No migration. The results file keeps whatever rows were written; old reds remain valid evidence under the old rule.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "guard", citation: "tests/unit/self-action-convergence.test.ts", enforcement: "ratchet"}` — the stage advance/revert loop is registered as `session-pool-stage-promotion`; under a regression that shows only at the target stage it promotes at most `MAX_TARGET_REDS_PER_COMMIT` (2) times per build and settles, across restart.

---

## Second-pass review

(appended below by the reviewer)

**Reviewer:** independent second-pass subagent, 2026-10-28.

**Concern raised:** the queue drains through the session router while the stage is 'dark'. src/commands/server.ts:3369-3392 (`_drainLocalDeliver`) calls `_sessionRouter.route()` for every row it drains. `_sessionRouter` is built whenever the pool is *enabled* (server.ts ~26770-26877), not only when the stage is past dark, and `SessionRouter` has no check of its own for the stage. The engine's `forceReplace` (server.ts ~27087, used at maxAttempts in QueueDrainLoop.ts:787) and its `holdVerdict`/ownership reads go the same way. The live path skips the router entirely at dark (server.ts:2930). This change now builds the engine at dark (server.ts ~27027) and stops the boot sweep expiring held rows as `pool-dark` (server.ts:11692-11699). Together that means two kinds of message now go through placement, ownership writes, cross-machine `deliverMessage` and forced re-placement at stage 'dark': messages taken into custody on `admission-refused` (server.ts:3313), and rows left over from before a demotion. That is the failover machinery a verified red E2E has just demoted. The artifact's claim in §5 is therefore only half right. The router's *intake* paths (`ordering-behind-queued`, `queueMessage`) do check the stage. The drain *egress* does not, so custody taken at dark is still routed and can be moved between machines. Suggested fix: when `_sessionPoolStage() === 'dark'`, make `_drainLocalDeliver` (and `forceReplace`) skip `route()` and deliver locally only. Or keep the engine gated on the stage until the drain is gated.

Lesser notes (not blocking):
- Inconclusive mapping: I found no path to a fabricated green. Exit 0 with no report, or with zero tests executed, now records nothing, which is safe. Reds still record when a report exists and shows failed tests or failed suites. A run that crashes before writing its report is the only real failure hidden, and §1 already says so. The report is deleted before each run, its mtime is checked against the spawn time, the driver runs one check at a time (`_inFlight`), and a timeout means `ranToCompletion:false`, so I see no stale-report path.
- Supersede rule (StageAdvancer.ts:94-104): the signature, commit and strict-ordering checks are sound, and a run that spans a stage change records nothing (SessionPoolFailoverRunner.ts:117-129). But a *genuine* regression that shows only at stage S now cycles: green at S-1 → promote → about one hour at S → red → revert → repeat. Before, the stale red reverted within one reconcile tick, so S was held for minutes. Now half the time is spent at a stage that verifiably fails at this commit. The ordering also uses wall-clock `ranAt`, so a backward clock jump could misorder rows. §2 understates this; consider refusing `advanceTo` while the target stage has a verified red for the same commit, with only a bounded number of re-tries.
- Classifier: `--outputFile`/`--outputFile.json` are handled as value-taking flags. A bare `--outputFile` followed by a test path swallows that path, which leaves no positional, and a run with no positional is classed as a suite. The mistake can only go the safe way, and other `--outputFile.<reporter>` variants still disqualify. No concern.

### Author response (Echo, 2026-10-28)

- **Blocking concern — fixed.** `_drainLocalDeliver` now reads `_sessionPoolStage()` at drain time; at `'dark'` it skips `route()` and goes straight to local delivery (outcome `handled-locally`), the same as the live path. The engine's `forceReplace` returns `false` at `'dark'`, so a row that ran out of local attempts is expired as `attempts-exhausted` with the normal loss notice, never force-re-placed onto another machine. The router intake paths were already stage-gated, so at dark the queue does no placement, no ownership write and no cross-machine forward. Pinned by a source-structure test in `tests/unit/inbound-queue-boot-order.test.ts`. The §5 claim is corrected by this change rather than reworded.
- **Re-promotion cycling — bounded.** `StageAdvancer.advanceTo` now refuses (`target-stage-red-limit:N`) once the target stage holds `MAX_TARGET_REDS_PER_COMMIT` (2) verified reds for the running build. A regression that only shows at the higher stage therefore gets at most two hourly tries there per build, then stays at the lower stage until a new build ships. Reds from older builds do not count. Both sides are covered in `StageAdvancer.test.ts`.
- **Wall-clock ordering.** Accepted residual risk: every row is written by this machine's own runner with its own clock, so only a backward clock jump between two runs could misorder them, and the worst case is one extra hour at the higher stage, still within the red-limit bound above.
- Classifier note: agreed, no change.

- **Found while modeling convergence:** in the tick where `reconcile()` demotes on a fresh red, the driver could immediately re-promote on the OLDER prior-stage green. `advanceTo` now also refuses (`target-red-newer-than-green`) unless the promoting green is newer than the target stage's latest same-commit red, the mirror of the supersede rule. The loop is registered in `src/testing/selfActionRegistry.ts` as `session-pool-stage-promotion` (real StageAdvancer + driver, regression only at the target stage, 600 one-minute ticks): it promotes exactly twice and settles at dark, including across restart. Declared closure `guard` citing `tests/unit/self-action-convergence.test.ts`.

**Second pass, round 2:** sent back to the reviewer for re-check (verdict appended below by the reviewer).

### Second-pass review — round 2

**Concur with the review.** I re-checked the fixes against the updated worktree. QueueDrainLoop calls out of the process at only two points: `dispatchInbound` (QueueDrainLoop.ts:823, which runs server.ts `_drainLocalDeliver`) and `forceReplace` (QueueDrainLoop.ts:787). Both now read the live stage. At 'dark', `_drainLocalDeliver` uses a `handled-locally` outcome without calling `route()` (server.ts:3376-3380), and `forceReplace` returns false. No queued row can reach a placement, an ownership write or `deliverMessage` at dark.

The other triggers all enter through those two calls: `onOwnershipTransition`, `onMachineOnline`, `onBreakerClose`, `onWake`, the backstop tick, and the post-transfer `forwardPendingInboundViaRoute` (server.ts ~12819). `holdVerdict` only reads ownership and the breaker in memory. At dark it can still *delay* a row behind a stale peer-owner record, but the hold is bounded and releases into local dispatch. That is a delay, not egress.

`recordRemoteReceipt` and `markRemoteInjected` are on the inbound side. A peer's own routing decision delivers to us, and that was already possible without the queue; only how durable our receipt is has changed.

The `MAX_TARGET_REDS_PER_COMMIT` cap in `advanceTo` closes the supersede oscillation I noted. One thing to know: capacity reds recorded under the old mapping for the commit that is running now also count toward the cap. That can only hold promotion back until the next build, so it fails in the safe direction. The author should know about it in case the stage stays put after this ships.
