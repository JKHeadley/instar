# Side-Effects Review — maturation board reads an all-empty measure as no measure

**Version / slug:** `maturation-board-empty-measure`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy session, owner of Feature maturation, topic 150026)`
**Second-pass reviewer:** `not required (read-only display parser; no gate, sentinel, session or messaging surface)`

## Summary of the change

`parseMeasure` in `src/monitoring/MaturationBoard.ts` now returns `null` (no measure) when every one of `what`, `now`, `target` and `before` is empty. Before, it returned `invalid`, and `parseReviewJson` then rejected the whole review file. On 2026-11-27 that dropped the day's 260-feature review from the board, because 29 features had all-empty measures. A partial measure, with some field set but no `what` or no `now`, is still invalid. Adds one unit test. Tier 1: one source file and one test file.

## Decision-point inventory

- `parseMeasure` / `parseReviewJson` file acceptance — modify — an all-empty measure no longer counts as invalid. The board decides nothing; it is a read-only display.

## 1. Over-block

Before this change, the board over-rejected: a whole review was dropped for one unmeasured feature. After it, no legitimate input is rejected that was accepted before.

## 2. Under-block

A review that writes all-empty measures by mistake, rather than because a feature could not be measured, now shows "no measure" for those features instead of failing. That is the correct reading of an empty measure, and the review's own text still carries its evidence.

## 3. Level-of-abstraction fit

This is the parser of the display read, which is the right place: the stored review is unchanged, and the board decides how to show it.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. The board is advisory (`authority: 'none'` in its response).

## 4b. Judgment-point check

There is no competing-signals decision point.

## 5. Interactions

The feature-maturation review job writes the file and is unchanged. The board, the console tile and the pool read all use the same parser, so they now agree on the newest review. There is no shadowing and no double-fire.

## 6. External surfaces

Readers of the board, through the dashboard, the console tile and `GET /maturation/board`, now see the newest review where they previously saw an older one. Nothing else changes, and no state is written.

## 6b. Operator-surface quality

The data on the existing board page changes; its layout does not. Leading action, internals, destructive actions and phone width are all unchanged.

## 7. Multi-machine posture

Machine-local by design: each machine parses its own review files. The pool read merges per-machine results as before.

## 8. Rollback cost

Revert the commit. No data or migration is involved.

## Evidence pointers

- `tests/unit/maturation-board.test.ts`: "reads an all-empty measure as no measure, so one unmeasured feature cannot reject the review". It covers both sides: all-empty gives null, and partial stays invalid.
- Live, on 2026-11-27 at 13:42 PT: the Studio's board reported the source `review:2026-11-27.json` as `ok:false, reason: features[16].measure` and served `reviewDate: 2026-11-23`.
