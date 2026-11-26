# Side-Effects Review — maturation board: peer absence is not missing data

**Version / slug:** `maturation-board-peer-absence`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

In `maturationBoardRoutes.ts` pool fan-out, a peer answering 503 (board off) or 404 (older version)
is still listed in `sources[]` but no longer added to the "may be superseded" list. Tier 1, ~10 LOC
plus one integration test.

## Decision-point inventory

No decision-point surface (display wording of a read-only page).

## 1. Over-block
No block/allow surface.
## 2. Under-block
No block/allow surface. A machine that genuinely holds a newer review but runs the board switched off
would not be named; the review machine runs the board, so this is the expected case, and the peer
still appears in sources with its reason.
## 3. Level-of-abstraction fit
Same place the warning is computed.
## 4. Signal vs authority compliance
Read-only display; no authority.
## 4b. Judgment-point check
None.
## 5. Interactions
None beyond the board's own response.
## 6. External surfaces
The page's warning sentence changes; the response schema does not.
## 6b. Operator-surface quality
Removes a false "may be out of date" warning the operator saw on the live board.
## 7. Multi-machine posture
Unchanged (proxied-on-read).
## 8. Rollback cost
Revert; nothing persisted.
## Conclusion
Safe display fix.
