# Side-Effects Review — Practice folds on the console Context page (context budget Phase 2)

**Version / slug:** `cb-p2-console-practice`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** not required (a read-only page section: no gate, no session lifecycle, no decision)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §11 ("shown on one dashboard card (console Settings → Context)"), §16 Phase 2 exit
**Stacked on:** #3567

## Summary of the change

The console Settings → Context page gets a "Practice folds" section read from `GET /context-budget/fold-shadow` (P2-4a):
- graded practice runs against the 40 needed for the Phase 2 exit;
- the would-be share of quiz answers lost, and how many runs would have been undone;
- runs that would have lost the operator's own words or a decision;
- why the other attempts did not run, in plain words, grouped from the record's codes (never the codes themselves).

Switched off, it shows one line. An older server with no route shows no section.

- **`dashboard/console/context-model.js`:** `practiceLines(res)` and `PRACTICE_INTRO`; `buildContextPage` takes an optional `practice` read.
- **`dashboard/console/context.js`:** fetches the route with the others and renders the block after the trial section.

**Files.** Modified: the two console files, `tests/unit/console-context.test.ts` (+6). About 60 LOC. Two console convention tests made me adjust: a reason-code regex that spelled the word "below" (a place word the page must not use), and two warning lines that needed a `warning-exempt` reason. They report a Phase 2 measurement, not an operator action.

## Decision-point inventory
None. A read-only display.

## 1. Over-block
None.

## 2. Under-block
The page reads this machine only, as the rest of the Context page does.

## 3. Level-of-abstraction fit
Same model/render split as every other Context section. Wording lives in the model.

## 4. Signal vs authority compliance
Display only.

## 5. Interactions
One more bearer GET per page load. It is in the same `Promise.all` and has the same failure display.

## 6. External surfaces
The console page (operator-facing). The text is plain words; no ids, routes or codes, which a test enforces.

## 7. Multi-machine posture
Machine-local by design, like the rest of the Context page ("This page reads this machine only").

## 8. Rollback cost
A revert.
