# Work cards: close as Done or Not important, whose turn, and the card's conversation

<!-- bump: patch -->

## What Changed

A person can now close a work card in Luna's two ways: **Done** with a closeout note, or **Not important** with a reason. Both are the owner's own tap (the dashboard PIN, or Face ID on the phone, where the note is part of what Face ID signs); the agent can never close a card. A close is an `archive` tap with `closeAs` (`done` or `not-important`) and a required `note`; `unarchive` reopens it. A Done card shows with the done cards and its note; a Not important card is archived.

"Not important" reasons become the agent's lessons: `GET /work-board/lessons` lists them with who gave them and which card they came from, and the agent's card-create answer carries the newest ten, so it sees them at the moment it raises a new card.

Every card now says whose turn it is (`turn`: `you`, `agent`, `others` or `nobody`) so screens can colour it, whether work has started (`started`, `startedAt`; untouched cards are listed first), and names its own conversation with the existing read and send routes (`conversation`), so the card and its chat can sit on one page.

The Work Board is still switched on only for development agents.

## What to Tell Your User

- **Closing cards**: "You can close a card as Done with a short note, or as Not important with a reason. I read those reasons before I raise a new card, so I stop asking about things you've told me don't matter."
- **Whose turn**: "Each card now says whether it's waiting on you or moving, so your screen can colour it, and cards nobody has touched yet come first."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Close a card as Done or Not important | Owner tap with `action: "archive"`, `closeAs`, `note` (PIN on the console, Face ID on the phone) |
| Dismissal lessons | `GET /work-board/lessons`; also `lessons` on the agent's `POST /work-board/cards` answer |
| Whose turn, started, conversation | `turn`, `started`, `startedAt`, `closeout`, `conversation` on every card read |

## Evidence

- Unit: `tests/unit/work-card-closeout.test.ts` (17).
- Integration: `tests/integration/work-card-closeout-routes.test.ts`.
- E2E: `tests/e2e/work-card-closeout-alive.test.ts`.
