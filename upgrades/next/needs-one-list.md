# Needs you shows a waiting project once, and it opens its card

<!-- bump: patch -->

## What Changed

When a Chief of Staff project waited on the owner, Needs you showed a line such as "Instar App is waiting on you" that opened the project chat. The Chief of Staff's wait card for the same project sat on the work board with the checklist and the Confirm done button. The server attached a "has a card" note to the line, but the dashboard and the iPhone app never showed it, so the owner saw the same thing twice with two different buttons.

The linking rule in `dashboard/console/needs-model.js` (`linkCoveredRows`), which builds both the console's Home and `GET /needs` / `GET /mobile/needs`, now makes such a line the card itself. The item keeps its id and source, uses the card's title and words, and its `action` opens the card. The project conversation moves to a new optional `alsoOpens` field. This applies whatever the card asks (an open wait or a Confirm done), so a project never shows as two lines. Only a server-owned card covering a key in the server-only `cos:` namespace can take over a row this way. Any other covering card still only links the row (`card`) and leaves its words and button alone, so an agent session's card can never redirect the owner's tap. A line with no card in the shown slice stays as before. The console strip shows `alsoOpens` as a second link under the row.

## What to Tell Your User

- **Needs you**: "Each project that's waiting on you now shows up once in Needs you. Tapping it opens its card, which has the checklist and the buttons. The project's conversation is linked right under it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A Chief of Staff wait is one Needs-you item that opens its card | Automatic; `GET /needs` items carry `action` → the card and optional `alsoOpens` → the project conversation |

## Evidence

- Unit: `tests/unit/work-board-cards-appear.test.ts` (a CoS row becomes its card, also when the card asks for Confirm done; no card leaves the row unchanged; a non-server card naming a `cos:` key only links it; a plan row covered by a server-owned card is linked, never taken over).
- Unit: `tests/unit/needs-read.test.ts` (through the server composer: one item per project, opening the card, with `alsoOpens`; the card's own row is not listed; a project without a card keeps its chat action; count 2 for 2 projects).
- Unchanged and passing: `console-chief-of-staff-needs`, `console-needs-first-screen`, `console-front-doors`, `cos-owner-pause`, `dashboard-cache-headers`.
