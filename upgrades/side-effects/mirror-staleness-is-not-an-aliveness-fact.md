# Side-Effects Review — an aliveness test stops asserting a fact about the calendar

**Slug:** `mirror-staleness-is-not-an-aliveness-fact`
**Date:** 2026-08-24
**Risk floor:** 1 (tests only; no runtime file touched)

## Summary of the change

An e2e aliveness test asserted `mirror.stale === false` against a baseline shipped inside the package. The baseline's `capturedAt` is 2026-07-24T01:20Z and the staleness threshold defaults to 30 days, so the assertion turned red at 2026-08-24T01:20Z on every branch at once, main included, with no commit involved. The e2e now asserts the wiring (present, `capturedAt` set, `stale` consistent with `staleDays`); the threshold moves to a unit test with an injected clock, pinned on both sides.

## Decision-point inventory

None. No runtime decision changes; `mirrorStatus()` is untouched.

## 1. Over-block

None. The e2e can no longer fail for a reason unrelated to the code under test — which is the point, and is a REDUCTION in false red, not in coverage: the staleness rule is now checked more strictly than before (two points, controlled clock) rather than incidentally.

## 2. Under-block

Named honestly: the e2e no longer notices if the SHIPPED baseline ages out. That was never something it could report usefully — it could only say "red today, green yesterday, same code" — but the information is real and now has no automated home. It is recorded under Known Limits in the release fragment rather than silently dropped.

## 3. Level-of-abstraction fit

This is the whole finding. An aliveness test answers "is the feature wired on the production boot path?". Whether a shipped artifact is under thirty days old is a fact about release cadence and belongs where the clock is an input. Putting it in the e2e put a calendar dependency in a layer that cannot control the calendar.

## 4. Signal vs authority compliance

Not applicable — tests only, no runtime authority.

## 4b. Judgment-point check

None.

## 5. Interactions

- **`safe-merge`** refuses on any red check, so this single assertion blocked EVERY merge from 01:20Z. Two open PRs (#1967, and anything opened later) were stuck behind it. That is why the fix is worth doing now rather than filing.
- **`mirrorStatus()`** is unchanged, so the `precondition-failed / stale-mirror` verdict path and the unit tests around it keep their existing behaviour.

## 6. External surfaces

None.

## 6b. Operator-surface quality

Improves it indirectly: the operator stops seeing a repo-wide red that no commit explains.

## 7. Multi-machine posture

`unified` — tests only, no per-machine state.

## 8. Rollback cost

Revert two test files. Reverting restores a build that goes red on a timer, so it should not be reverted quietly.

## Conclusion

Ship.

## Phase-5 second pass

**Not required, and not run** — no block/allow decision, no session lifecycle, no gate/sentinel/guard/watchdog, no runtime file touched. Stated explicitly so the section below is not mistaken for an independent reviewer's concurrence.

## The finding that outlives the fix

This is the second time today the same shape has appeared, in two unrelated subsystems: a correctness claim resting on wall-clock timing. This morning it was a thread id whose uniqueness came only from the millisecond (fixed in #1971). Tonight it is a test whose verdict came only from the date. Both fail without a commit, both look like flake, and both get *more* likely with time or speed rather than less.

The tempting cheap fix here was to bump `capturedAt` in the shipped baseline. That would have made the suite green in one line and fabricated a capture that never happened — turning a true signal ("the shipped baseline is old") into a false one. Worth naming because it was the obvious move and it was wrong.

## Evidence pointers

- `origin/main` at `9f83c19ca`, e2e run locally: 1 failed / 4 passed, `expected { present: true, …(3) } to match object { present: true, stale: false }`. Main was red on the clock, not on a change.
- `src/data/benchmarkPredictions.json` → `capturedAt: 2026-07-24T01:20:00.000Z`; age 31 days; `mirrorStalenessMaxDays` default 30 (`BenchmarkDivergenceAnalyzer.ts:110`).
- Negative control: with the threshold comparison removed from `mirrorStatus()`, the new unit test fails (1/26). Restored: 26/26. E2E 5/5.

## Class-Closure Declaration (display-only mirror)

The class is "a test whose verdict depends on wall-clock aging of a committed artifact." Closed for this one assertion. NOT closed generally — no sweep was run for other date-sensitive assertions, and the sibling class named above (correctness resting on wall-clock timing, in runtime code as well as tests) is not swept for either. Named, not claimed.
