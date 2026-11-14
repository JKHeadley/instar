# Side-Effects Review — maturation board sort choice + "couldn't check" wording

**Version / slug:** `maturation-board-sort`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change
Dashboard-only: `maturation-board-model.js` adds `SORTS` + pure `sortRows(rows, sort)` and a
`sort` URL-state key; `maturation-board.js` adds a `<select>` and uses `sortRows` per group;
`console.css` styles it. The subline wording for the may-be-superseded source changes from
"<machines> didn't answer" to "Couldn't check <machines>". Six new unit tests. The legend hint also says what a square without a dot means (operator asked).

## Decision-point inventory
None — display ordering of a read-only page.

## 1. Over-block
No block/allow surface.
## 2. Under-block
No block/allow surface.
## 3. Level-of-abstraction fit
Pure model function beside the existing `orderInGroup`; the default delegates to it.
## 4. Signal vs authority compliance
Not a decision point.
## 4b. Judgment-point check
None.
## 5. Interactions
Unknown sort values fall back to the default order; URL state is clamped by the existing parser.
## 6. External surfaces
One new control on the board page; one sentence reworded.
## 6b. Operator-surface quality
Restores the sort control from the original request; removes an overstated "didn't answer".
## 7. Multi-machine posture
Client-side only; unchanged.
## 8. Rollback cost
Revert three dashboard files; nothing persisted.
## Conclusion
Small, reversible UI change.
