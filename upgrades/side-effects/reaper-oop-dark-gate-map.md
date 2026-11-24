# Side-Effects Review — hand-kept dark-gate line map shifted by +2

**Version / slug:** `reaper-oop-dark-gate-map`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change
Test-only. `tests/unit/lint-dev-agent-dark-gate.test.ts` keeps a hand-written map of each `enabled:` line number in `ConfigDefaults.ts`. The test forbids regenerating it, so it is edited by hand.

PR 3490 adds a net 2 lines at line 489: the hourly `reapIntervalMs` default with its comment. So 25 of the 30 rows below that point move down by 2, and a comment records why. No source changes.

## Decision-point inventory
None: comment-only, no runtime change.

## 1. Over-block
No issue identified.

## 2. Under-block
No issue identified.

## 3. Level-of-abstraction fit
No issue identified.

## 4. Signal vs authority compliance
No issue identified: no decision logic changes.

## 4b. Judgment-point check (Judgment Within Floors standard)
None.

## 5. Interactions
None. The ratchet now counts 494, equal to its baseline.

## 6. External surfaces
None.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
None.

## 7. Multi-machine posture (Cross-Machine Coherence)
Not applicable.

## 8. Rollback cost
Trivial (a revert).

## Conclusion
Safe: comments only.

## Second-pass review (if required)
Not required.

## Evidence pointers
lint-dev-agent-dark-gate 31/31 after the change. Before it, the Assertion C (e) golden path failed on the merge with main.

## Class-Closure Declaration (display-only mirror)
n/a: comment-only.
