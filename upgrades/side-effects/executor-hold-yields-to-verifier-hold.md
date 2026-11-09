# Side-Effects Review — The attempt hold yields to a restart Local Verify's queue is waiting for

**Version / slug:** executor-hold-yields-to-verifier-hold
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 4 runtime files, about 45 runtime lines, plus unit and integration coverage. Fixes fb-7459b8b6-a7f: while Local Verify is in a verifier hold (the installed verifier changed on disk, so no verify can start until the server restarts) with work queued, the feedback executor's attempt hold (`restartHolds()`, up to `ATTEMPT_RESTART_HOLD_MS` = 2 h per attempt) could defer exactly that restart. Measured 2026-11-07 15:54:51–16:11:35Z on the Studio: the test slot idle 16.7 minutes with 11 queued. `LocalVerifyService.restartNeededForQueuedWork()` is a pure read of the open hold plus a non-empty queue; `FeedbackExecutorService.restartHoldYields()` reads it through a new optional `localVerifyNeedsRestart` option; `restartHolds()` withdraws the hold while it is true, except for an attempt in its publish window (`verifying` / `publishing`), and writes `execute:restart-hold-withdrawn` once per attempt; `buildFeedbackExecutor` and `AgentServer` pass `options.localVerify` in. The 2 h hold is unchanged in every other case. Effort: no spec rounds, one commit attempt.

## Decision-point inventory
- Update restart admission (`UpdateGate.getActiveHolds` via the `feedback-executor` provider) — modify: the provider answers "no hold" in one more case. The updater's own ceiling, bypass and other providers are untouched.
- Attempt lifecycle after a restart — pass-through: unchanged. A `claimed` row ends `stopped` / `interrupted` on the next tick (`stale-epoch` when the epoch moved and it is not adoptable; re-claimable either way, counts no failure episode; its daily start is consumed, as any interrupted attempt's is); a `verifying` row with its review tree and publish clone intact is re-verified once. Nothing is reported as a success.
- The publish window (`verifying` / `publishing`) — keeps its hold: a restart there parks the item `publish-outcome-unknown` with a HIGH attention item to the operator, the one outcome the yield would have made worse, and the window is seconds long. Second-pass finding; fixed before commit.

## 1. Over-block
None added: this change only removes a hold. A restart Local Verify's queue is waiting for now goes ahead while an attempt is in setup or verification, and that attempt is interrupted (see the inventory). That is the intended trade: one attempt's setup or checks (re-run from a fresh claim) against a test slot that otherwise stays idle for every queued PR for up to 2 h.

## 2. Under-block
The hold is read when the updater checks. A verifier hold that opens after a deferral was recorded on a `feedback-attempt` blocker is seen by the deferral's 5-minute retry timer (`recheckRestartHolds` only brings a retry forward for `local-verify` blockers), so the idle bound after this change is about 5 minutes, not zero. Withdrawing the hold does not by itself restart: the updater's window and session gates still apply, so an attempt with a `restart-hold-withdrawn` row may complete normally. A verifier hold with an EMPTY queue keeps the attempt hold, by design: nothing is waiting on that restart. The restart writers that never read holds (the lifeline's unresponsive restart) are unchanged. The daily start the interrupted attempt consumed is not refunded; at the default cap of 6 that is one of six for the day, and the next tick may claim the item again.

## 3. Level-of-abstraction fit
The decision lives where the two facts meet: Local Verify owns "is my queue waiting on a restart?" (one pure reader next to the hold it reads), the executor owns "do I hold the restart?", and the updater keeps its single hold-evaluation path. No new authority, no new timer.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No — this change produces a deterministic fact consumed by the existing updater authority. A throwing or missing reader keeps the hold (the previous behavior), so a fault can only make a restart later, never lose an attempt.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point: both inputs are enumerable facts (an open verifier hold, a non-empty queue, an attempt in setup or verification).

## 5. Interactions
- Local Verify's own `restartHolds()` names a RUNNING verify; under a verifier hold nothing runs, so the two providers cannot disagree about the same restart.
- The executor's update brake (`executorUpdatePending`) stops new claims while a restart is pending, so the yield cannot be re-triggered by a fresh attempt each tick.
- `restartHolds()` is called by the gate's status and recheck paths; the audit row is written once per attempt (in-memory set) so repeated reads do not flood the audit log. The set is not persisted: the restart the hold stood aside for ends the process, and a withdrawal that never restarted repeats its row on the next process at most once per attempt.
- No races with cleanup: the reader is synchronous and touches no attempt state.

## 6. External surfaces
The updater's deferral status no longer names a feedback attempt while Local Verify is held with work queued; on such a machine the restart comes sooner. One new audit event, `execute:restart-hold-withdrawn`, in the feedback-factory audit log. No operator-facing actions, no notices, no URLs.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Machine-local BY DESIGN: a restart hold applies to the process that would be restarted, and both facts (the verifier hold, the attempt in setup) belong to that same process. No notices, no durable state, no URLs. No status route changes.

## 8. Rollback cost
Plain revert. Nothing persisted beyond audit rows.

## Conclusion
The review changed two things in the design: the first draft read `snapshot()` from the server wiring, which builds the whole status answer on every hold check; replaced by a two-field pure reader on the service. The second pass found the yield also dropped the hold for an attempt in its publish window, where a restart escalates to the operator; that window now keeps its hold, with a unit case. Clear to ship with the touched tests green here.

## Second-pass review
**Reviewer:** independent Claude subagent (read-only, against the diff and the surrounding restart code)
**Independent read of the artifact:** concern raised, then addressed.
- Blocking: the yield covered the publish window (`verifying` / `publishing`), where a restart parks the item and raises a HIGH attention item; recommended keeping that hold. Fixed: publishing rows are excluded from the withdrawal, unit case added.
- Non-blocking: the recheck cadence claim was inaccurate (a `feedback-attempt` deferral waits for the 5-minute timer); corrected in §2. "The attempt is lost" overstated what the withdrawal does; wording and the audit event renamed to `restart-hold-withdrawn`.
- The reviewer could not run the touched tests from its seat (native module unbuilt there); they were run here, see Evidence pointers.
- Verified accurate: the post-restart lifecycle and daily-start account, no interruption loop (the update brake stops new claims while a deferral stands), once-per-attempt audit, and the wiring with `options.localVerify` undefined or a throwing reader.

## Evidence pointers
- Unit: `tests/unit/localVerify/LocalVerifyService.test.ts` (reader on both sides and stopped), `tests/unit/feedback-factory/execute-service.test.ts` (hold kept / withdrawn / publish window kept / unreadable keeps), `tests/unit/feedback-factory/execute-wiring.test.ts` (builder pass-through).
- Integration: `tests/integration/feedback-github-runtime-routes.test.ts` (a real `AgentServer` passes `options.localVerify` in; a server without Local Verify never yields).
- Live: fb-7459b8b6-a7f, Studio 2026-11-07 15:54:51–16:11:35Z, 16.7 min idle with 11 queued.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. Not a self-triggered controller: this removes a hold; it fires no restart, swap, respawn, spawn, notify, retry or kill of its own.
