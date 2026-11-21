# Side-Effects Review — takeover-ready pool spec branch: CI green-up (one in-brace annotation)

**Version / slug:** `takeover-ready-pool-spec-greenup`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (comment-only change; no block/allow, session-lifecycle, gate, sentinel or watchdog surface)

## Summary of the change

Tier 2 by inheritance (the branch is the converged `docs/specs/takeover-ready-pool.md` spec); the change itself is one comment. The branch is a spec change plus the two `gemini-payg-reconcile` documentation rows. Its Local Verify run failed on `tests/unit/no-silent-fallbacks.test.ts` (495 catch blocks against a baseline of 494). The extra block is not on this branch: `main` itself counts 495 since #3603 merged (`src/core/UpdateChecker.ts`, `findBundledNpmCli`, the layout probe `} catch { /* not this layout */ }`, whose 20-line detector window includes the `return null;` two lines below). This branch merges current `main` (ordinary merge commit) and gives that catch its in-brace `@silent-fallback-ok` reason: a candidate path that does not exist or is not a file is simply not this layout, and the loop tries the next candidate. The baseline is not raised. Size: 1 source line plus this artifact; 1 commit attempt.

## Decision-point inventory

None. The catch skips a non-matching filesystem layout inside a probe loop; the annotation records the reason and changes no behaviour.

## 1. Over-block

Not applicable: no block/allow surface.

## 2. Under-block

Not applicable: no block/allow surface. The probe's failure mode (no bundled npm found) is already surfaced by the caller, which logs a warning naming the fallback to PATH's npm.

## 3. Level-of-abstraction fit

The reason belongs on the catch itself, which is where the ratchet reads it. Fixing it on this branch (rather than only on `main`) is the shortest path that lets this spec change pass Local Verify now and heals `main` when either lands; the hunk is a single comment, so any other branch carrying the same line merges cleanly.

## 4. Signal vs authority compliance

No authority added or changed. The ratchet is a signal that gates the build; satisfying it with a stated reason is the designed path.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point.

## 5. Interactions

None: a comment inside an existing catch. Confirmed by running the ratchet (passes) and the UpdateChecker unit files (`UpdateChecker.test.ts`, `update-checker-apply.test.ts`) on this tree.

## 6. External surfaces

None.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no operator-facing text changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable: no runtime change. The updater code in question runs machine-locally by design (it rebuilds a native module for the node that will run on that machine).

## 8. Rollback cost

Revert the one-line commit; nothing else to undo.

## Conclusion

Comment-only; clear to ship.

## Evidence pointers

- `tests/unit/no-silent-fallbacks.test.ts` passes on this tree (and fails on current `main` without the annotation).
- `tests/unit/UpdateChecker.test.ts`, `tests/unit/update-checker-apply.test.ts` pass on this tree.
