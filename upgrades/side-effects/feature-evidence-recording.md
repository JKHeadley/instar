# Side-Effects Review — Evidence recording in switched-off features

**Version / slug:** `feature-evidence-recording`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, appended below`

## Summary of the change

Adds `featureEvidence.record` (and `recordAtMostEvery` for per-message paths) at the decision points of 113 features across 85 files, and marks them measured in the registry. Spec: `docs/specs/feature-maturation-ladder.md` §4 and §13. Tier 2 by spread; each call is additive and cannot change behaviour.

## Decision-point inventory

No decision point is added or changed. Each call observes a decision that already happened.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. Recording misses what a feature cannot see about itself: a wrong decision reads like a right one until graded. Agents flagged double replies, wrongly refused holders and spurious reaps as undetectable from inside; the review's grading covers those.

## 3. Level-of-abstraction fit

One thin call at each feature's decision point, through one log. Hook scripts and CI scripts cannot call it and are listed as not covered.

## 4. Signal vs authority compliance

Signals only; no call's result is read. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The call appends synchronously, so it stays off per-tick paths; per-message paths use `recordAtMostEvery`. `catch` blocks that gained a recording call stay non-throwing. The log is wired only when the ladder is on, so on the fleet every call is a no-op, and rows from before the log is wired at boot are lost. A source-order test on `/messages/relay-agent` used a 30 KB window that the added lines outgrew; widened to 40 KB.

## 6. External surfaces

None. Rows stay on the machine; only numbers leave. `context` holds reason codes, counts and non-secret ids, and text passes `scrubForStore`.

## 7. Multi-machine posture

Per-machine facts read through each machine's route and the board, as the spec states.

## 8. Rollback cost

Revert, or set `maturation.ladder.enabled` false, which makes every call a no-op.

## Evidence

`tsc` clean; unit tests of each changed module; `tests/unit/FeatureEvidenceLog.test.ts`; the full run is the merge gate.

## Second-pass review

Independent subagent, first read: "Concern raised". `allPeersPresumedGone()` in a record's arguments could throw on a corrupt registry just before the lease self-suspend, so the self-fence would be skipped; three per-message or per-request paths recorded without the limiter; one `.message.slice` could throw on a non-Error. All fixed: those facts came out of the lease context, the three paths use `recordAtMostEvery`, and the error read is guarded. A wider grep of added arguments found no other call that can throw on a load-bearing path. It found no message text or credentials in the sampled context, and every feature id in the registry. It sampled by risk, not all 85 files. Concur after fixes.

## Class-Closure Declaration

`unbounded-self-action`: closure `n/a`. These calls observe decisions other code already made; none triggers an action or a retry. Row volume is bounded by rotation and, on per-message paths, by `recordAtMostEvery`.

## Stage-B certified set

`src/monitoring/DegradationReporter.ts` sits in the certified Codex delivery closure and gained a recording call, so the evidence log and its rotation helper entered the closure. Both are listed as excluded, with reasons: write-only, never throwing, and off the delivery path. The certified fingerprint is unchanged.
