# Side-Effects Review — Skill Learning Sentinel: maturation-ladder entry (data only)

**Version / slug:** `skill-learning-sentinel-ladder-entry`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds the `monitoring.skillLearning` entry to `src/data/feature-ladders.json` so the approved spec
`docs/specs/skill-learning-sentinel.md` (whose maturation plan names `ladder: monitoring.skillLearning`) passes the
ladder-coverage test ("every spec that names a ladder names a real entry"). Data only: the flag ships `enabled:
false`, no runtime reads this entry until the sentinel's slices land; the entry's metrics read
`logs/skill-learning.jsonl` rows that nothing writes yet (`tracking.state: needed` says so). Fleet rung advances by
a reviewed code change (`kind: code`), per the Maturation Path article (g) and the spec's plan.

## Decision-point inventory

None. A registry row for a feature that is off everywhere.

## 1. Over-block
No block/allow surface — not applicable.
## 2. Under-block
No block/allow surface — not applicable.
## 3. Level-of-abstraction fit
The ladder registry is where every staged feature's thresholds live (Maturation Path (e)); this is the only place
such an entry can go.
## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface.
## 4b. Judgment-point check
The thresholds (10 would-create rows, 10 % regression, 14-day windows) are graduation evidence floors read by the
recurring review; they gate a default flip, never agent behaviour. Not a judgment point.
## 5. Interactions
`maturationUniverse` coverage test and the ladder routes read it; the Growth analyst's dark-flag inventory lists it
as a staged switch with a plan. No double-fire.
## 6. External surfaces
None beyond the ladder/console read surfaces. Ships in the package.
## 6b. Operator-surface quality
Not applicable (no renderer change).
## 7. Multi-machine posture (Cross-Machine Coherence)
Replicated — the registry ships in the package to every machine; each machine evaluates the metrics over its own
logs (the existing ladder posture). No notices, no URLs.
## 8. Rollback cost
Remove the entry; nothing persists.
## Conclusion
A one-row data change that unblocks the approved spec's merge. Clear to ship.
## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect and no self-triggered controller — not applicable.

**Release fragment:** `upgrades/next/skill-learning-sentinel-ladder.md` (added 2026-11-06 after the pre-push gate asked for one; this artifact is the review for that same data-only change).
