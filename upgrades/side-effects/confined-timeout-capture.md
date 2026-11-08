# Side-Effects Review — Confined timeout capture

**Version / slug:** confined-timeout-capture
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, 1 runtime file plus one unit test, about 20 runtime lines. At a confined command's time limit, `runCapped` appends the first-output time and a process listing to its stderr before killing the tree. Effort: no spec rounds.

## Decision-point inventory
- Time-limit stop — pass-through: same stop and result fields; stderr gains text.

## 1. Over-block
No block/allow surface.

## 2. Under-block
The listing covers the process group only, so a descendant that left the group is not shown. It captures one instant, not history.

## 3. Level-of-abstraction fit
`runCapped` is the only place that knows the group and holds it before the kill.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Diagnostic text only.

## 4b. Judgment-point check
None.

## 5. Interactions
`ps` is synchronous, bounded to 2 seconds, and happens only at a limit. The base-failure classifier never reads a timed-out run, because `limit()` returns first. Other readers of a timed-out result's stderr (the canary, the dependency rebuild tail) get the added text, which they scrub and bound before storing. Command lines could contain sensitive text; records pass through `scrubForStore`, and each line is cut at 160 characters. On Windows there is no group and the listing reads "unavailable".

## 6. External surfaces
`lastCheckFailure.detail` and similar records show the extra lines.

## 7. Multi-machine posture
Machine-local BY DESIGN: the process runs here.

## 8. Rollback cost
Plain revert.
