# Side-Effects Review — CI absorb: onAccepted wiring window + silent-fallbacks baseline

**Version / slug:** `working-set-ci-absorb`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (test-shape + comment-trim fix; 7 LOC of src change is comment-only)`

## Summary of the change

Two CI gates legitimately flagged the P2.2b onAccepted insertion:
1. `session-pool-activation-wiring` slices 4200 chars from `onAccepted: (cmd) => {`
   and asserts the owner-resume bridge markers inside it — the working-set
   trigger prefix pushed them out. Fix: comment trimmed (6 lines → 2) and the
   window widened 4200→5000 with a note naming why.
2. `no-silent-fallbacks` baseline: +2 parser-counted defensive catches from the
   transfer machinery (fd-close guard, vanished-file path) — both
   in-brace-justified, both surface as COUNTED outcomes. Baseline 459→461 with
   the documented justification block (the established ratchet format).

## 1. Over-block / 2. Under-block / 3. Fit / 4. Blast radius

No behavior change: the src edit is comment-only; the test edits keep both
gates' intent (the wiring markers must exist; the baseline only ever ratchets
with written justification). Blast radius zero at runtime.

## Evidence

- `tests/unit/session-pool-activation-wiring.test.ts` + `tests/unit/no-silent-fallbacks.test.ts` — 12 passing.
- e2e + coordinator suites re-run green (14). Typecheck + lint clean.
