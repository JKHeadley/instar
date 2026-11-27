# Side-Effects Review — main's "unverified" clock moves forward on a green verify of an older head

## Summary of the change

`src/localVerify/mainHealth.ts` gains a pure function `oldestUnverifiedAfterGreen(prev, verifiedHeadIsCurrent, runStartedAtMs)`. `LocalVerifyService` calls it when a `main` verify record with outcome `success` arrives, in place of the single line that cleared `mainObs.oldestUnverifiedAt` only when the verified head was the current head (or the head a release commit collapses into). New behaviour: current head → clear (unchanged); an older head whose run STARTED while it was main's observed head → the clock becomes `max(previous, run start time)`; an older head whose run started after main had already moved past it → the clock is left alone (unchanged from before); no clock → nothing. To know which case applies, `start()` records, for a `main` entry, whether its head is main's observed head (or its release alias) at that moment (`mainRunOnCurrentHead`). Tests in `tests/unit/localVerify/mainHealth.test.ts`.

## Decision-point inventory

One existing decision point is touched: `MainHealth.noteUnverifiedAge`, which turns `healthy` into `main-suspect` (`unverified-too-long`) when the clock is more than 3 hours old. In `main-suspect` the status reconciler holds `instar/local-verify` at pending for passed heads and the merge hand-off answers `status-pending`, so it has blocking authority over every merge. The threshold and the transition are unchanged; what changes is the input (the clock).

## 1. Over-block

Before: with merges landing more often than a `main` verify takes (about 35 minutes), no green verify is ever of the current head, the clock is never cleared, and all merging stops 3 hours after the last restart no matter how many green verifies ran. Observed 2026-11-14 16:51:59Z. After: that case no longer blocks. Remaining over-block: none identified that this change adds.

## 2. Under-block

The clock may only move past merges that a green verify contains. A run covers every merge up to its start only if it starts on main's head as observed then. That is not always so: a queued `main` entry is replaced by a newer head only when that head is enqueued (after the debounce), not when it is first observed, so a run can start on an older head after waiting behind PR runs, on an error retry with backoff, or as the re-run after a first failure. The first version of this change advanced the clock in those cases too and could skip an uncovered merge by up to about 30 minutes; the second-pass reviewer found it. Now `start()` records whether the entry's head is main's observed head at that moment, and only such a run moves the clock. Any other green verify of an older head leaves it where it was, exactly as before this change.

Remaining gap, stated plainly: main's head is observed by polling (the status reconciler's pass), so a merge that lands after the last poll and before a run starts is not in the verified head, yet the run counts as started on the current head and its start time is after that merge. The clock then treats that merge as covered. The error is at most one poll interval, and that merge is in the head of the next `main` verify.

`record.startedAt` is the run process's own clock at entry to the run (`orchestrator.ts`), before preflight, on the same machine; it is validated as an ISO time by `validateRecord`. Only the local run-completion path produces a `main` record here; there is no peer, imported or replayed `main` success. A failing or erroring `main` verify does not touch the clock.

## 3. Level-of-abstraction fit

The rule belongs where the clock lives. It is extracted as a pure function next to `decideMainHeadEnqueue` so it is tested directly; the service keeps one call.

## 4. Signal vs authority compliance

The alarm is a deterministic floor with blocking authority by design (a hard invariant: do not keep merging onto an unverified main). This change does not add authority or a new detector; it corrects the measurement the existing floor reads.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is added. The 3-hour limit is an existing floor and is unchanged.

## 5. Interactions

- `decideStart` fair share reads the same clock (`oldestUnverifiedMainAt`, 90 minutes): with the clock moving forward after each green verify, `main` is given priority over PRs less often than before under sustained merging. That is the intended reading of "oldest unverified merge"; before, the stale clock made `main` permanently "due", which is part of why the coordinator ran `main` back to back.
- The release-collapse path (`main-release-collapsed`) clears the clock on its own line and is untouched.
- `MainHealth.onVerify` is untouched (a green returns suspect to healthy when there is no red head, or the red head is this head or an ancestor of it).
- The clock is in memory only; a restart starts it fresh, as before.

## 6. External surfaces

None changed. The audit log gains no new event. GitHub statuses change only in that `instar/local-verify` is no longer held pending by a false alarm.

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the clock belongs to the lease holder's process, like the rest of `mainObs`. `LocalVerifyService.ts` is part of the verifier version, so the coordinator and a peer must run the same build; a peer on an older build is skipped until it updates, as with any verifier change.

## 8. Rollback cost

Revert the commit. No state is persisted by this change.

## Conclusion

A measurement bug in a blocking safety check: it stopped all merging exactly when the line was most productive. The fix makes the clock mean what its comment says, keeps the alarm for the real case, and is covered by tests that fail on the old behaviour and on the first, too-generous version of the fix.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the production code before the author's conclusions; read-only (no test run)

First read: "Concern raised". The first version advanced the clock on any green verify of an older head. The reviewer showed that a `main` run can start on a head main has already moved past (a queued entry is replaced only when the newer head is enqueued after its debounce; error retries and the re-run after a first failure reuse the old head), so that version could skip an uncovered merge by up to about 30 minutes, not "one poll interval" as this artifact first said. It also found the "alarm still fires" test never moved the clock and that its comment was wrong, and corrected the description of `onVerify`. It confirmed that only the local run-completion path produces a `main` success record, that `startedAt` is the run process's own entry time on the same machine, and that the current-head, release-alias, failure and error paths are unchanged.

Changes made: the gate in `start()` and `completeMain` described above; the two tests rewritten and a third added (a re-run on an older head does not move the clock; it fails with the gate forced on, checked by mutation and restored); sections 2 and 5 corrected.

Second read: the gate is correct in every start path (one assignment of `inFlight`, no resume path for a `main` run, a stale flag cannot match); the remaining poll-interval gap is described accurately; tests and artifact are right. Noted and left: the clock uses the child's `startedAt`, a few seconds after the moment the gate is decided; the release-alias start and the error-retry start are not tested at service level (same gate). "Concur with the review".

## Evidence pointers

`.instar/logs/local-verify.jsonl` on the coordinator, 2026-11-14: `lease-acquired` 13:51Z; `main-record` success 16:21:31Z (head 1b6fb4ab); `main-health` healthy → main-suspect `unverified-too-long` 16:51:59Z; PR 3123 `record` success 16:53:30Z, `merge-handoff-result` `status-pending`. Feedback fb-19b703a2-502.
