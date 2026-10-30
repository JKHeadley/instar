# Side-Effects Review — Maturation Board readability revision

**Version / slug:** `maturation-board-readability`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required (display-only change to a read-only page)`

## Summary of the change

Display redesign of the maturation board after operator feedback (spec §11). Files: the console view
and view model (`dashboard/console/maturation-board{,-model}.js`), styles, tests; the builder and
route accept three optional, length-capped review fields (`area`, `summary`, `nextStep`) and pass them
through. Tier 1: display only, revert restores the previous layout. ~600 LOC incl. tests; 1 build pass.

## Decision-point inventory

No decision-point surface. Plain groups are a fixed, total mapping of the review's verdicts; the board
still adds no judgement.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. Display limit: until a review supplies `summary`, rows show only a plain name
and chip (the old per-row repeated blurb is removed on purpose).

## 3. Level-of-abstraction fit

Plain language is produced where the understanding is (the review job writes `summary`/`nextStep`);
the page only arranges it.

## 4. Signal vs authority compliance

Unchanged: read-only, `authority: 'none'`.

## 4b. Judgment-point check

None added; the group mapping is a closed table over the existing verdict enum.

## 5. Interactions

The new fields ride the existing review contract and pool payload; older reviews without them still
render (fallback names derived from ids).

## 6. External surfaces

The page layout changes; the route schema stays `maturation-board/1` (fields are additive and
optional). Text-only rendering is unchanged and re-tested with injected markup.

## 6b. Operator-surface quality

This change exists for operator-surface quality: first screen is one sentence, one picture and plain
groups; phone layout read at 390 px; colour always paired with a word; technical detail behind a tap;
one search box instead of seven dropdowns.

## 7. Multi-machine posture

Unchanged (unified via proxied-on-read).

## 8. Rollback cost

Revert the commit; no state, config or migration involved.

## Conclusion

Display-only revision of a read-only page; safe to ship.

## Evidence pointers

- `docs/specs/maturation-board.md` §11; `tests/unit/console-maturation-board.test.ts`; `tests/unit/maturation-board.test.ts`

## Addendum — test timing seam

`createMaturationBoardRoutes` takes optional pool timings (peer, fan-out, review fetch). Production
passes none and keeps 750 ms / 2.5 s / 3 s. The integration suite passes wide values because one
verifier run on a loaded peer machine failed a single integration test while GitHub's run passed;
the pool tests depend on real peer servers answering in time.
