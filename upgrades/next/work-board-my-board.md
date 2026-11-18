# Work Board: My board

<!-- bump: patch -->

## What Changed

Every Work Board read (`GET /work-board`, `GET /mobile/work-board`) now carries `myBoard.sections`: the cards that need the reader, each card once under its most pressing reason, in Luna's order: "Waiting for your approval", "Waiting for your reply", "Your cards", "Cards you were added to" and "Held for later". Each section lists `cardIds` (untouched cards first, then started ones, newest first), `notStarted`, and `more` when the board's soft limit cut some. Nothing is stored and no rule changes: the sections are worked out on each read from the same cards the lanes show, and a team member's sections come only from cards they can already see. The waiting lane's soft cut now breaks equal-time ties by card id, so every machine keeps the same cards.

The Work Board is still switched on only for development agents.

## What to Tell Your User

- **My board**: "Your Work tab now opens on the cards that need you, grouped by why: waiting for your approval, waiting for your reply, your own cards, and anything on hold. Each card shows once, and the ones nobody has touched yet come first."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| My board sections | `myBoard.sections` on `GET /work-board` and `GET /mobile/work-board` |

## Evidence

- Unit: `tests/unit/work-board-my-board.test.ts` (9).
- Integration: owner phone and member phone assertions in `tests/integration/work-board-routes.test.ts`.
- E2E: `myBoard` on the real route in `tests/e2e/work-board-alive.test.ts`.
