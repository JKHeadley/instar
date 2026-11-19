# Work Board cards actually appear

<!-- bump: patch -->

## What Changed

The Chief of Staff now opens one Work Board card for each tracked project that is waiting on the owner, and closes it itself when a later check, the owner's pause or the project's close clears the wait (never on an unreadable check). The card says what the check saw, the goal and checklist, a recommendation and why it needs the owner, and links the project conversation. It is server-owned: sessions cannot write to it, and a person's taps still work. Agent cards written through the route must now carry `recommendation` and the new `whyYou` field (`recommendation-required` / `why-you-required`). A card the owner carries that sends nothing outward no longer waits for an Approve tap; an agent's claim on such a card is finished only by the owner's Confirm done. A card can name the plan or pull request it is about (`covers`); Needs you then shows that item once, in its own words and with its own action, with a link to the card. The Chief of Staff cards follow `workBoard.chiefOfStaffCards` (on for development agents, off on the fleet).

## What to Tell Your User

- **Decisions show up as cards**: "When one of your projects is waiting on you, it now shows up as a card on the work board, with what it needs, my recommendation and why it needs you. It closes by itself once you have answered."
- **Fewer taps**: "A card that only asks you to do something no longer needs an Approve tap first."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Chief of Staff wait cards | Automatic when the board is on; `workBoard.chiefOfStaffCards` switches them |
| Required recommendation and why-you on agent cards | `POST /work-board/cards` with `recommendation` and `whyYou` |
| A card linked to its Needs-you item | `covers: ["plan:<id>"]` or `["pr:<n>"]` on the card |

## Evidence

Tests: `tests/unit/chief-of-staff-wait-cards.test.ts` (27: open, edit only on change, close on each clearing record, never on unknown or absence, fence, crash resume, reopen, park and unpark, wiring), `tests/unit/work-board-cards-appear.test.ts` (19: approval amendment both sides, claim rule, created-first fold, covers allowlist, required fields, graduation exclusion, Needs-you linking), plus the related existing unit files, all passing locally; integration and e2e additions run in Local Verify.
