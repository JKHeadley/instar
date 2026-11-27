# Side-Effects Review — Work board card and tiles, redesigned on the dashboard

**Date:** 2026-11-18
**Author:** Echo
**Tier:** 1. Static dashboard assets only (`dashboard/console/work.js`, `work-model.js`, `console.css`) plus tests. A revert fully undoes it. Size: 3 source files, about 450 added lines, 1 new test file, 3 test files adjusted. Effort: no spec rounds (Tier 1), one commit attempt planned.
**Why:** Justin, 2026-11-18 20:05 PST, on the Work Board card detail: "The UI is pretty terrible. We can do much better. Please use modern and aesthetic best practices to make the content extremely pleasant (a delight to look at) and easy to digest." The iPhone, Mac and Android builders are doing the same design; this is the dashboard's part.

## What changed

- **Opened card:** a hero with a "From the Chief of Staff" chip, a "Waiting on you · since yesterday 2:15 PM" chip (relative time from the wait start), the title in large type and the one-sentence ask under it; "Why you" as a muted line by the ask. The recommendation is an accented callout with the buttons directly under it: the main one filled (Done), the other choices outlined (Not important), Put on hold and Remove for good as plain text. A Checklist with status icons (✓ passes, ● needs you, ○ not known, ✕ fails, each with screen-reader words), then the card's own Done-when items with their evidence. Goal, "The Chief of Staff said", the record (carried by, approval, links, questions, who carried it, taps) are folded under Details. The conversation is a chat panel (agent left, you right, work-board lines centred) read with the page's own sign-in, with "Open full conversation" and "Reply in the conversation". From 1100 px the sheet is wide with two columns (content | conversation); below it, one column.
- **Board tiles:** a status chip (plus the Chief of Staff chip and "Not started" where they apply), the title, one line saying what it asks, "Since …", and one main button. The other buttons are one tap away in the opened card.
- **Data:** a card's optional `brief = { ask, goal?, checks?, chiefSaid?, waitingSince? }` (being added server-side by another branch in `ChiefOfStaffWaitCards.ts`, not touched here) is used when present. Without it, `parseNeed` reads today's Chief of Staff need prose: "Goal:", the "Done when (from the project):" bullets with their trailing ": <state>", the quoted check note, "Waiting on you since <UTC>" (to relative time), Markdown escapes undone, "(wait xxxxxxxx)" dropped. Any other card's need stays one Markdown body under "What is needed". All of this is pure and tested in `work-model.js`.

## Decision-point inventory

None added or changed. Which buttons a card offers still comes from `cardActions`; this change only ranks them for display (`rankActions`: the server's primary tone first, else Done; Put on hold and Remove for good go quiet). Every tap still goes through the same confirm step, the dashboard PIN and the server's own checks. Reading the conversation uses the existing `GET /mobile/chat/app/:key/messages` with the page's bearer, which the server already allows for the owner.

## 1. Over-block
No issue identified. Nothing is refused or hidden that was available: tiles show one main button, and the rest are on the opened card one tap away (the closeout test now opens the card for Not important).

## 2. Under-block
A need that does not follow the Chief of Staff shape is shown whole as Markdown, as before, so a parse miss shows more, not less. A check line whose state the parser does not know shows without an icon state ("–"), not a wrong one.

## 3. Level-of-abstraction fit
Words and parsing live in `work-model.js` beside the page's other words (the Needs-you copy floor requires that file); `work.js` only places them. When the server sends `brief`, the parser is not used.

## 4. Signal vs authority compliance
No authority anywhere in this change; docs/signal-vs-authority.md applies unchanged. The server stays the authority on every tap.

## 5. Interactions
`sheet()` in ui.js is unchanged; the card adds a `sheet-wide` class to its own panel. Other sheets keep their width. The sheet bar reads "Work board card" while the dialog keeps the card title as its label. Open PR #3377 also edits `work.js` (a different part); a merge conflict there would be textual. Not touched: `needs-strip.js`, `needs-model.js`, `needsRoutes.ts` (PRs #3475, #3380), `ChiefOfStaffWaitCards.ts`.

## 6. External surfaces
The web console Work page only. The conversation panel reads messages but cannot send: sending needs this browser's signed device, which the full conversation page has, so the panel links there.

## 7. Multi-machine posture
Machine-local by design: static assets served by the machine the browser talks to. The conversation read asks `scope=pool`, so a conversation held on another machine is still read.

## 8. Rollback cost
Revert the commit. No data, config or migration.

## Operator-surface quality

Answering the Operator-Surface Quality question: is it good when the operator uses it?
- **First screen leads with the ask:** the opened card shows who it is from, how long it has waited, the title and the one-sentence ask, then the recommendation with Done under it, all in the first screen at 1280x728 and 390x844.
- **Taps, not text:** no raw input is asked for; the close note step is unchanged.
- **Plain words:** the wait id, UTC stamps and Markdown backslashes no longer reach the screen.
- **Targets:** buttons, the Details toggle, links and tile titles are at least 44 px tall.
- **Phone:** one column, no horizontal scroll at 390 (scrollWidth 390, sheet 388 of 388); full-width buttons on a phone.
- **Themes:** dark and light from the console's existing tokens; checked in both.

## Verification

- `tests/unit/console-work-brief.test.ts` (new, 18 cases): `parseNeed` on the live need text byte for byte and a confirm card (passes, fails, needs you, the "and N more" line, escapes, wait id), the brief winning with statuses kept to the four, a session card's first sentence and body, chips, waiting words, tile ask, action ranking, chat lines, the conversation path refusing anything but an app path, and four page flows in jsdom (tile with one button; opened card hero, callout, button ranks, no "…", checklist icons, Details folded with the goal, no wait id or UTC or escapes; the chat panel; empty and unreadable conversations).
- Adjusted: `console-work-model.test.ts` (tile chip in place of the need line on the tile; "Open full conversation"), `console-work-closeout.test.ts` (Not important from the opened card), `console-work-slice2.test.ts` (Why you before Recommended).
- Also run green: console-work-my-board, work-board-wiring, work-board-cards-appear, console-needs-first-screen, console-warning-paths, dashboard-refresh-keeps-place, dashboard-controls-labeled, dashboard-viewport-scroll, console-front-doors, operator-surface-gate, dashboard-refresh-interaction-hold, console-dom, dashboard-empty-states, html-site-ratchet.
- Headless Chromium against a local mock (the live board JSON from GET /work-board plus four sample messages; not the live dashboard), 1280x728 and 390x844, dark and light, before and after: `/Users/dabombstudio/.instar/proof-rigs/workboard-card-redesign/shots/` (before-*.png, after-*.png, after-light-*.png, before-light-*.png). No page errors; no horizontal scroll.
