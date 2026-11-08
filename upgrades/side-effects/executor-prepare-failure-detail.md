# Side-Effects Review — Executor prepare failure detail

**Version / slug:** executor-prepare-failure-detail
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, 1 runtime file plus one unit test, about 10 runtime lines. Setup failures keep both ends of the message, derive the step from the whole scrubbed message, and note a kill signal. Effort: no spec rounds.

## Decision-point inventory
- `prepareFailureStep` — pass-through: same matcher, now given the whole message. The step is a label only.

## 1. Over-block
No block/allow surface.

## 2. Under-block
No block/allow surface. Whether a shutdown kill should count against the item is not decided here; this records the evidence for that.

## 3. Level-of-abstraction fit
The existing recording path in the catch block.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Diagnostic text only.

## 4b. Judgment-point check
None.

## 5. Interactions
The audit log keeps its id-shaped step only, which can now read more specifically than "other"; nothing branches on it. Scrubbing runs on the longer text before any cut, so a secret cannot be split by the cut and escape the scrubber.

## 6. External surfaces
`lastPrepareFailure.detail` in the executor status can be up to 503 characters instead of 300. Its shape is unchanged.

## 7. Multi-machine posture
Machine-local BY DESIGN: executor state belongs to the owner.

## 8. Rollback cost
Plain revert.
