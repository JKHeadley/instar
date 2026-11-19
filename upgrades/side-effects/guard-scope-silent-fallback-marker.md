# Side-Effects Review — mark one returned-error catch in SourceTreeGuard.presence()

**Version / slug:** `guard-scope-silent-fallback-marker`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change
Comment-only. Adds a `@silent-fallback-ok` marker to the catch in `presence()` (`src/core/SourceTreeGuard.ts`), which is new in this branch. The no-silent-fallbacks ratchet counted it (495 > 494).

It is not a swallow:
- an absent path returns `false`;
- any other error is returned as `{ error }`, which the caller records as indeterminate evidence.

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
None. The ratchet counts 494 again.

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
`tests/unit/no-silent-fallbacks.test.ts`: 5/5 pass after the change, and 495 before it.

## Class-Closure Declaration (display-only mirror)
n/a: comment-only.
