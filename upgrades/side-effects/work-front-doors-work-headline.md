# Side-Effects Review — Work page headline and "N more" (found before Justin's try-it)

**Version / slug:** `work-front-doors-work-headline`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (wording and a show-more toggle; no gate, no data, no authority)`

## Summary of the change

Found by the dashboard session on Echo's real console after stage 1 and 2a went live: the Work page showed "Needs you · 11" with real items and, right under it, the big headline "Nothing on the board is waiting on you." and "Nothing is waiting on you." That reads as the page contradicting itself; the cards-versus-other-needs distinction is internal. And "8 more things need you." was plain text with no way to see them.
1. `work-model.js`: with no card waiting the headline is the neutral "The work board"; the empty "Waiting on you" lane says "No cards right now."
2. `needs-strip.js`: "N more things need you. Show all" is a button that shows every item in place ("Show fewer" closes); `stripModel` takes `{ expanded }`. CSS keeps the strip's frame.
3. iPhone (apps/instar-ios f055d92): the empty "Waiting on you" lane says "No cards right now." too. Android shows the console page.

## 1. Over-block / 2. Under-block
No issue identified.

## 3. Level-of-abstraction fit
Words in the console models (tested); the expand state is the strip's own.

## 4. Signal vs authority compliance
No decision with authority.

## 5. Interactions
The strip's 45 s refresh keeps the expanded state (module-level, per page load). The needs-first-screen test still passes.

## 6. External surfaces
Console and iPhone wording only.

## 7. Multi-machine posture
Client-side; no state.

## 8. Rollback cost
Revert the commit.

## Evidence
- Unit: `tests/unit/console-work-model.test.ts` (neutral headline), `tests/unit/console-front-doors.test.ts` ("Show all" shows every item).
- Live on Echo's real server at 1280x728 and 390x844 with this branch's `needs-strip.js`, `work-model.js` and `console.css` served to the browser: headline "The work board", lane "No cards right now.", "9 more things need you. Show all" opens all 12 items, "Show fewer" closes; no horizontal scroll.
