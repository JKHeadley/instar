# Side-Effects Review — mark two intended realpath fallbacks in the reaper ops

**Version / slug:** `reaper-oop-silent-fallback-markers`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change
Comment-only. Adds `@silent-fallback-ok` markers to two `realpathSync` fallbacks in `src/monitoring/agentWorktreeGit.ts`. These lines are new in PR 3490, at :902 and :904. The no-silent-fallbacks ratchet counted them on the merge with main (496 > 494).

Each falls back to comparing the literal path. That makes the worktree containment check stricter, never wider: an unresolvable path is not treated as inside the worktrees root.

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
`tests/unit/no-silent-fallbacks.test.ts`: 5/5 pass after the change, and 496 before it.

## Class-Closure Declaration (display-only mirror)
n/a: comment-only.
