# Side effects: promise actions always name the machine that holds the promise

Console-only. The promise sheet added `?origin=<machine>` to its action requests only for a
replica row. Promise ids are numbered per machine, so the same id (CMT-1206) existed on the
Studio (pending), the Mini and the Laptop (expired). A bare-id request for the Studio's own
promise was refused with "ambiguous across machines" — Approve failed for the operator on
2026-11-01. The sheet now always sends the origin it read with the row, for Approve, Decline,
Mark as done, Drop and Resume.

1. Over-block: none; the server already resolves an own-machine origin to the local record.
2. Under-block: a legacy row with no recorded origin still sends a bare id (unchanged).
3-5. Same routes, same authority. 6. None. 7. Proxied/owner-routed exactly as before.
8. Revert.

## 6b. Operator-surface quality
No visual change; the buttons now work.

## Also: History at phone width
Operator screenshot 2026-11-01 23:05: on a phone the History view and composer ran off the right
edge. Tool lines never wrap, so their min-content width widened the open session and the page's
grid column (measured 760 px in a 390 px viewport). `min-width: 0` on `.main`, `.sess-view`,
`.sess-open`, `.sess-term-wrap`, `.sess-composer` and the input keeps them inside the screen
(measured 358 px); long tool lines are cut with an ellipsis as designed. "Back to live" no
longer floats over History, which has no live stream. Desktop is unaffected (same widths).
