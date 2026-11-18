# Side-Effects Review — Accept all keeps its page when the unlock runs out, and the list never dead-ends

**Version / slug:** `accept-all-keeps-its-page`
**Date:** `2026-11-16`
**Author:** `Echo (topic 144007, Accept all round 2)`
**Second-pass reviewer:** `not required (dashboard view and one PIN-sheet option; no gate, sentinel, server route or session lifecycle)`

## Summary of the change

Justin retried "Accept all 21 projects" at 20:33 PST on 2026-11-16 (1.3.1856, which already had the round-1 progress line). His words: "still feels buggy and sluggish in the response. Also, clicking the button just seems to make it reload". His screenshot: Suggested efforts with only "Loading suggestions...".

What the Studio's graph state shows (look-only): no new owner change and no new suggestion started after 11:41; the tap never got past project 1. Every Conversations read on the Studio took 3 to 9 seconds and froze the server while it ran (server fix: `graph-read-view-cache`), so a 21-project Accept all is about 150 slow reads. The PIN unlock is a fixed 15 minutes, and the page's lock watcher clears the whole page the moment it runs out: Accept all stopped, the page showed Unlock, and after the PIN the list reloaded from scratch ("Loading suggestions…", slow) with the button back at "Accept all 21 projects". That is the "reload".

Fix (Tier 1, 2 source files, about 50 LOC):
- `ui.js`: `operatorSessionRemainingMs()`; `askPin({..., fresh:true})` asks even while an unlock is held.
- `conversation-suggestions.js`: `keepUnlocked(needMs)`. Accept all asks for the PIN in a sheet before it starts when less than 10 minutes of unlock are left, and before each project when less than 5 are left. The sheet sits over the page, so the list, the progress line and the run stay. Closing the sheet stops with words and a working button ("Accept all did not start: it needs your PIN." / "Stopped at 4 of 21: it needs your PIN. 3 of 21 accepted. Tap Continue; nothing is lost."). A single card's Accept does the same with 5 minutes.
- The button reads "Continue accepting projects" whenever a project is already part-way (on the server or in this tab), so a reload no longer looks like a fresh start.
- The list load says "Still loading suggestions. Your agent is busy; this can take up to 20 seconds." after 5 seconds, and a failed or timed-out load shows its words with a "Try again" button (it used to show only "Suggestions could not be loaded. Try again." with nothing to tap).

- A step the agent does not answer (timed out, 408 or 5xx; the real two-machine run with the M5 frozen produced exactly this) is a wait with "The agent did not answer. Tap Continue to try again; nothing is lost.", never "This suggestion is no longer available" (which now means a real 404 only). Two unanswered projects in a row stop with "Stopped at N of M: your agent is not answering right now. …".

Effort: 2 commits, no spec rounds (Tier 1). In line with the size.

## Decision-point inventory

None. The page only decides when to ask for the PIN; the server still checks every request.

## 1. Over-block

The owner may be asked for the PIN once more than before (when starting Accept all with under 10 minutes of unlock left). That is the cost of not losing a run; the sheet says why.

## 2. Under-block

The security bound is unchanged: the unlock still lasts 15 minutes, a lapsed unlock still clears the page (the lock watcher is untouched), and the server still refuses an expired proof. Asking early only gets a fresh unlock through the normal PIN route.

## 3. Level-of-abstraction fit

The rule lives in the view that runs the long action. `askPin` gains one option instead of a second PIN sheet.

## 4. Signal vs authority compliance

- [x] No authority. The page asks; the server's PIN check decides.

## 4b. Judgment-point check

No new heuristic: two fixed thresholds (10 and 5 minutes) sized to one project's worst-case waits.

## 5. Interactions

- The lock watcher in `conversations.js` (clears private content at expiry) is unchanged; asking at 5 minutes left keeps a run from reaching it.
- `askPin` callers that do not pass `fresh` behave exactly as before.
- The round-1 progress line, skip-past and stop rules are unchanged.

## 6. External surfaces

Dashboard Conversations → Review suggestions only. New words are listed above.

## 6b. Operator-surface quality

Every new state has words and a way to act (Continue, Try again, the PIN sheet). To be checked on the real Studio page at 390x844 and 1280x728 before the owner is asked to retry.

## 7. Multi-machine posture

Client-side only. The unlock is per page; progress still resumes across tabs and machines through the server's per-suggestion create request id.

## 8. Rollback cost

Revert the commit; the next release restores the old behaviour. No data or migration.

## Conclusion

A long Accept all no longer loses its page and progress to the 15-minute unlock, and the list never shows a dead end. The slowness itself is fixed on the server (`graph-read-view-cache`).

## Evidence pointers

`tests/unit/console-conversations-dom.test.ts`: five new tests (the fifth: a project the agent does not answer for is a wait with plain words); (PIN sheet keeps the page and the run finishes with one list load; closing the sheet leaves words and a working button; a part-way project offers Continue; a failed load offers Try again and a slow one says it is still loading). `npx vitest run tests/unit/console-conversations-dom.test.ts tests/unit/console-conversation-suggestions.test.ts`: 45 passed.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a dashboard behaviour defect, closed by the tests above).
