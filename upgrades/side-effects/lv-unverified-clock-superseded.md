# Side-Effects Review — the unverified-main clock follows green verifies of heads that were replaced

## Summary of the change

`src/localVerify/mainHealth.ts`: `oldestUnverifiedAfterGreen` gains a fourth argument, the time the verified head was replaced, and takes the later of that and the covering run's start; new pure helpers `noteHeadSuperseded` (records the first time a different head was observed after a head; bounded at 50; ignores flips back to a head already recorded) and `supersededAtFor` (a head's replacement time, following its release-commit alias). `src/localVerify/LocalVerifyService.ts`: an in-memory map `mainSupersededAt`, filled in `noteMainHead`, read where a green `main` verify updates `mainObs.oldestUnverifiedAt`; the result is clamped to now. Tests in `tests/unit/localVerify/mainHealth.test.ts`.

## Decision-point inventory

One existing decision point, unchanged in kind: when `main` enters `main-suspect` for `unverified-too-long` (which makes merges repair-only). Only the clock feeding it is computed more exactly.

## 1. Over-block

Before: on a busy day the clock never moved, and `main` went suspect three hours after the first merge following a restart, however many green verifies ran (2026-11-15: suspect from 13:38Z, passed PRs held). After: the clock follows the verified heads, so that false alarm is gone. It can still alarm early in a few strict cases, none new in kind: a failed read at the moment the head changes (nothing is recorded), a release commit replaced before its 10-minute debounce (never aliased, so the head's own earlier time is used), an empty map after a restart, and eviction past 50 heads. This change removes an over-block and adds none.

## 2. Under-block

The safety property is that the clock is never later than the true time of the oldest uncovered merge.

- The replacement time is the first observation of a newer head by the once-a-minute reconcile pass, so it can be up to one poll interval later than the merge itself. Failed reads null the observed head and record nothing, so they cannot widen that. The clock already used the same observation basis.
- One narrow lenient sequence remains: a newer head B is seen first, then a stale read shows an older head A for long enough to be enqueued (10 minutes unchanged, or the 30-minute cap), then a head C never seen before follows directly. A is recorded as replaced when C appears, and a green verify of A then moves the clock past B's first sighting. The pre-existing run-start rule has the same hole and a larger one. `noteHeadSuperseded` skips a flip back to a head already recorded, which closes the repeated-flip form (B, A, B, A).
- A record whose `startedAt` lies in the future could park the clock in the future (pre-existing); the result is now clamped to now, which bounds the error to one run's length rather than removing it.

## 3. Level-of-abstraction fit

The rule lives in the pure functions beside the existing clock rule; the service only supplies observations it already makes.

## 4. Signal vs authority compliance

No new authority. The existing deterministic gate (repair-only while `main` is not healthy) reads a more exact input.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. The three-hour limit (`MAIN_HEALTH_LIMITS.unverifiedSuspectMs`) is untouched.

## 5. Interactions

- `isCurrent` (verified head is current, or the current head's release alias) still clears the clock and wins.
- The #3170 rule (a run that started on the then-current head covers to its start) is kept; the later of the two times is used. Two existing tests change expectation by five minutes each because the replacement time is later and more exact than what they assumed; both still alarm.
- `releaseAlias` (capped at 50) is read only; an evicted or never-set alias falls back to the head's own, earlier time.
- A green verify already cleared an unknown-origin suspect; what brought it back 14 seconds later on 2026-11-15 was the stale clock. With that fixed, and with PR #3190 (a new head is verified two minutes after it appears while `main` is suspect), a suspect `main` recovers on the next green verify instead of needing a restart.

## 6. External surfaces

None new. `main-health` transitions in `logs/local-verify.jsonl` and the `instar/local-verify` status text `main-suspect · repair-only` appear less often.

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, unchanged: the clock and the new map live in the memory of the machine holding the serving lease, like the rest of main health (`local-verify-merge-authority`). After a restart the map is empty and the clock restarts at the first observation, as before; the boot verify clears it if its head is still current when it finishes. A lease move on a running server clears neither the map nor the clock, which is harmless because entries keep their first time.

## 8. Rollback cost

Revert the commit. No state.

## Conclusion

Removes a recurring false `main-suspect` that closed merging about every three hours under normal load, without loosening the three-hour limit.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the working tree, not the author's conclusions; read-only (no test run)

First read: the production logic holds the safety property in every realistic path traced (ordering after a failed read, flipped and skipped reads, an old sha becoming head again, the release alias, retried and re-armed runs, bounds and restart). "Concern raised": two of the three new service tests did not test what they claimed. The release-commit test would fail on the new code (the release commit was never aliased in its sequence, and the run did not start on the current head), and the headline 2026-11-15 test passed on the OLD code too (its timestamps were weeks ahead of the harness clock, and every run in it started on the current head). It gave corrected sequences for both, and suggested clamping the clock to now and not recording a flip back to a known-older head.

Changes made in response: both tests rewritten to the reviewer's sequences on the harness clock; the clamp added with its own test; the flip guard added to `noteHeadSuperseded` with its pure test updated; one pre-existing test's expectation moved five minutes (to the replacement time) and renamed. The files were then run: 61 and 9 pass.

Second read: traced the old clock through both rewritten tests: the headline test fails on the old code at round 6 (+210 minutes), the release test at its first assertion; the clamp can only lower the clock and its test fails without it; no scenario found where the flip guard makes the clock later; nothing new broken. It asked for three wording corrections in this file (the over-block claim was too strong, the under-block bullet described a sequence the guard now closes, the lease-move sentence was wrong), all made above, and noted one optional refinement (treat a future start time as unknown instead of clamping), not taken: the clamp is strict enough and simpler. Final line: "Concur with the change".

## Evidence pointers

- Incident: `logs/local-verify.jsonl` 2026-11-15: green `main-record` at 10:24:34Z (a8b9dc3f), 12:45:33Z (3f415950), 14:26:10Z (4b9b6155); `main-health` healthy to `main-suspect` `unverified-too-long` at 13:38:46Z, and again at 14:26:24Z, 14 seconds after the 14:26:10Z green.
- Tests: `tests/unit/localVerify/mainHealth.test.ts` 61 pass, `mainRedHoldService.test.ts` 9 pass (run 2026-11-15T15:14Z in the setup window of a Studio run).
