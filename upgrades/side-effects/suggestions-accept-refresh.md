# Side-Effects Review — Review suggestions: no 30 s reload, and an Accept is never cancelled by one

**Version / slug:** `suggestions-accept-refresh`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (dashboard refresh behaviour on one view; no gate, sentinel or session lifecycle)`

## Summary of the change
Justin (topic 141385, 2026-11-16 11:43 PST) tapped "Accept all 21 projects" on Conversations → Review suggestions; the list reloaded about every minute and the accept "didn't take". Cause: the console's route() re-runs every page every 30 s unless the page called `ctx.selfRefreshing()` or `refreshHeld(main)` is true. `renderConversations(main)` ignored ctx, so each re-run aborted the previous render's AbortController; `current()` turned false and the Accept-all loop and the card's `run()` returned silently mid-way, then the list was redrawn from the server (same 21 items).

Fix (Tier 1, 2 source files, ~10 LOC):
- `conversations.js`: `renderConversations(main, ctx)`; the suggestions view calls `ctx.selfRefreshing()` (it already has its own Refresh button). The retry closure keeps ctx. Other Conversations views keep the 30 s refresh.
- `conversation-suggestions.js`: a running Accept marks its card `data-interaction-open`, so `refreshHeld` holds any page refresh while it runs (belt and braces if a caller omits ctx).
- Tests: `tests/unit/console-conversations-dom.test.ts` — the suggestions view opts out of the page cycle, refresh is held during an Accept and released after, and a stop shows words; the ordinary list does not opt out. The new test fails without the fix.

Effort: 1 commit attempt so far, no spec rounds (Tier 1).

## Decision-point inventory
None. This only changes when the dashboard redraws one view.

## 1. Over-block
The suggestions view no longer refreshes by itself every 30 s. Newly built suggestions show on the Refresh button or on revisiting the page. Acceptable: the list changes rarely and the owner is acting on it.

## 2. Under-block
Accept can still stop for real reasons: owner PIN session expiry (the page shows the Unlock card; progress is kept and Continue resumes), or a step that cannot commit while another machine has not confirmed (the card says "Saved here. Waiting for <machine> to confirm. Tap Continue later; nothing is lost."). On 2026-11-16 the Studio's graph peer calls to mac-lan were failing (fb-a720de02-a00, filed by the Chief of Staff session); this fix does not address that, but those stops are now shown in words instead of being wiped by a reload.

## 3. Level-of-abstraction fit
Uses the existing page-lifecycle contract (`selfRefreshing`, `refreshHeld`), the same one chats.js uses. No new mechanism.

## 4. Signal vs authority compliance
No authority; UI refresh only.

## 5. Interactions
The lock watcher (250 ms enforceLock) is unchanged and still clears private content on PIN expiry. Sheets and inputs still hold refresh as before.

## 6. External surfaces / 6b. Operator surface
Dashboard Conversations → Review suggestions only: no periodic reload; Accept / Accept all run to completion or show why they stopped.

## 7. Multi-machine posture
Client-side only. Accept progress already resumes across tabs and machines via the server's per-suggestion create request id.

## 8. Rollback cost
Revert the commit; the next release restores the old refresh.

## Evidence
`npx vitest run tests/unit/console-conversations-dom.test.ts tests/unit/console-conversation-suggestions.test.ts tests/unit/console-conversations-v2-dom.test.ts` — 50 passed; the new test fails with the source change removed.
