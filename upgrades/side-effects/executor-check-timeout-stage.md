# Side-Effects Review — Executor check timeout stage

**Version / slug:** executor-check-timeout-stage
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, 1 runtime file plus one unit test, about 10 runtime lines. `verifyFix` returns a `detail` naming the check when a run hits a time or output limit. The reason string and control flow are unchanged. Effort: no spec rounds, first commit attempt.

## Decision-point inventory
- `verifyFix` limit stops — pass-through: same stop, same reason, same order; only `detail` is added.

## 1. Over-block
No block/allow surface changed.

## 2. Under-block
No block/allow surface changed. The record keeps only the latest failure, so earlier ones stay unlabelled in the audit log.

## 3. Level-of-abstraction fit
Uses the existing `failed` detail path and `recordCheckFailure`, which already record other check failures.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Diagnostic text only; no authority.

## 4b. Judgment-point check
No judgment point touched.

## 5. Interactions
`verifyFix` callers already accept `detail`. Output is scrubbed and clamped by `recordCheckFailure`, the same as other check failures, so no raw command output reaches the store.

## 6. External surfaces
`lastCheckFailure` in the executor status is populated in more cases. Its shape is unchanged.

## 7. Multi-machine posture
Machine-local BY DESIGN: executor state belongs to the owner that runs the attempt.

## 8. Rollback cost
Plain revert. No migration.
