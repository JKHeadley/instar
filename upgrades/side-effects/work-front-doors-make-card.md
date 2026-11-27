# Side-Effects Review — Work front doors: "Make a card" from a message (console)

**Version / slug:** `work-front-doors-make-card`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (console-only; uses the existing owner card-create route and its PIN proof; no gate, authority or server change)`

## Summary of the change
Spec docs/specs/work-front-doors.md §7 stage 2 bullet 2. In Conversations, each message in a Telegram or app conversation gets a quiet "Make a card" button. It opens a sheet prefilled from the message (title = first line, "What is needed" = the message), asks "Done when", then the dashboard PIN, and POSTs the ordinary `POST /work-board/cards` with `source: { conversationKey, messageId }` (fields the card store already accepts and credential-checks). On success the board opens the new card (`#/work/board?card=<id>`). New: `dashboard/console/make-card.js`; `conversations.js` passes the node to each message row; one CSS rule; `tests/unit/console-make-card.test.ts`.

## Decision-point inventory
None new. The card-create route keeps its own owner proof (PIN), limits and credential check.

## 1. Over-block
Slack conversations and efforts get no button (no source key mapping yet); a message with no text gets none.

## 2. Under-block
Nothing is approved by making a card; the board's own refusals come back as their message.

## 3. Level-of-abstraction fit
Console-only, over the existing route; the pure parts (source key, message id, draft, body) are a tested module.

## 4. Signal vs authority compliance
No authority added; the owner's PIN is the proof, as for every console card write.

## 5. Interactions
`source.conversationKey` uses the Chief of Staff key spelling ("telegram:<topic>", "app:<key>"), the same keys `projectKey` uses. Making a card does not set `projectKey`, so it does not appear under a project until the owner or Chief of Staff gives it one.

## 6. External surfaces
None beyond the console.

## 6b. Operator-surface quality
1. Seen on Echo's real conversations headless at 1280x728 and 390x844 (2026-11-16 10:40 PT, local files served over the live console, PIN unlocked): the button sits under each message, the sheet reads "Make a card / The card links back to this message. / Title / What is needed / Done when / Cancel / Make the card", prefilled, no sideways scroll. The final "Make the card" press was NOT made on Echo (no test cards on the operator's real board); the request body is covered by the unit test.
2. Plain words; every refusal is a sentence.
3. Phone width: the sheet fits; the long need text scrolls inside its box.
4. The "From:" link back on the card, the card tile on its source conversation, and the iPhone version are the next step of stage 2b (recorded in .instar/lanes/work-front-doors-1114/stage2b-plan.md under CMT-1841).

## 7. Multi-machine posture
The card is written by the serving machine's board, as any console card.

## 8. Rollback cost
Revert; cards already made keep their `source` field, which the board already accepts.

## Evidence
`tests/unit/console-make-card.test.ts`; console conversation tests still pass.
