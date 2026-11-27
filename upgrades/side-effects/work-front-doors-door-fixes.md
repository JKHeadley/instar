# Side-Effects Review — Work front doors: the two door fixes found on the real server

**Version / slug:** `work-front-doors-door-fixes`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (navigation only; no gate, no data, no authority)`

## Summary of the change

Found by the Chief of Staff session on Echo's real server after stage 1 (PR 3192) went live on the Studio (1.3.1830), against docs/specs/work-front-doors.md:
1. The Conversations door opened the browser-device chat page whenever browser devices were on; on Echo that page read "No conversations yet". The spec keeps the conversations hierarchy as the door ("conversations-model.js keeps its hierarchy"). `doorHref('conversations')` is now always `#/work/conversations` (Chief of Staff first, All one tap away); the chat page stays reachable from it.
2. The bare `#/work` address (old links, typed addresses, a door clicked before the board probe answered) opened the old Work menu. The spec says the Work door opens straight on the board. With the board on, `resolveRoute('#/work')` now redirects to `#/work/board`, and a page already on `#/work` moves onto the board when the probe answers late. With the board off it still opens the Work section (Promises, Plans).

## Decision-point inventory
None: navigation only.

## 1. Over-block
The Work section menu page is no longer reachable by its bare address while the board is on; its contents are on the Agent page (stage 1 §2.1) and each of its pages keeps its own address.

## 2. Under-block
No issue identified.

## 3. Level-of-abstraction fit
The door rules live in `nav-model.js` (pure, tested); `console.js` only applies them.

## 4. Signal vs authority compliance
No decision with authority.

## 5. Interactions
The phone app's in-app console (phone mode) keeps its own routing (redirects are web-only, unchanged). The browser-device chat page listing nothing for a browser device on Echo is a separate defect in that feature, filed to the feedback factory.

## 6. External surfaces
Web console only.

## 7. Multi-machine posture
Client-side routing; no state.

## 8. Rollback cost
Revert the commit.

## Evidence
- Unit: `tests/unit/console-front-doors.test.ts` (the door hrefs; bare `#/work` with the board on and off; pages inside the Work section still open).
- Live on Echo's real server (1.3.1830), 1280x728 and 390x844, with this branch's `nav-model.js` and `console.js` served to the browser: landing and the Conversations door open "Your efforts" (Chief of Staff, then All); the Work door and a typed `#/work` open the board ("Nothing on the board is waiting on you.").
