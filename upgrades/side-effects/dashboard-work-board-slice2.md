# Side-Effects Review — Work Board slice 2 on the dashboard

**Date:** 2026-11-17
**Author:** Echo
**Independent reviewer:** fresh general-purpose reviewer against the server code. It confirmed `GET /needs` items carry `card` (server `cardOf` keeps only `wc_` + 16 hex ids and `#/work/board?card=` links), the `pr:` key format matches, no id or `cos:` key reaches the screen, and the card link does not disturb the strip's focus-preserving refresh. One defect fixed: following the same card link a second time did not open the card (the page remembered it had opened it once); the card is now taken out of the address once open, so a later tap opens it again while a refresh still never reopens a closed card. One wording fix: the same pull request written two ways (`pr:3404`, `pr:#3404`, `pr:03404`) is named once.
**Tier:** 1, console display for docs/specs/work-board-cards-appear.md §2–3 (server side in #3404).

## Decision-point inventory
Display only. The opened card shows **Why you** under the recommendation, an **About** line for the items it covers (pull requests by number, plans by kind), and, on a server-owned card, **Written by: The Chief of Staff**; the row carries the tag "From the Chief of Staff". The Work page now also takes `card=` out of the address after opening that card, so a link can be followed again. A Needs-you row the server linked to a card (`card {id, href, label}`, added by `linkCoveredRows`) shows a small second link to that card beside the row, which keeps its own action.

## Over-block and under-block
No block/allow surface. The card link is shown only when its address is a Work page card link (`#/work/board?card=…`); any other value shows no link. The Chief of Staff's own `cos:` key and plan ids are never shown.

## Level of abstraction
Words in work-model.js (`coversWords`, `chiefOfStaffCard`) and needs-strip.js (`cardLinkOf`); work.js and the strip only place them. Which rows link is decided by the shared needs model in #3404, not here.

## Signal versus authority and judgment
No authority change. docs/signal-vs-authority.md applies unchanged.

## Interactions and external surfaces
Web console Work page and Needs-you strip. The phone apps show the same fields (app session). A card without these fields, from an older server, shows as before.

## Multi-machine posture
A machine on an older build drops `whyYou` and `covers` (spec, Multi-machine posture); the card then shows without them.

## Rollback
Revert the static asset change. No data repair.

## Verification
7 cases in console-work-slice2.test.ts (about words including duplicate and differently written keys, server-owned, card-link safety, the opened card and row in jsdom for a Chief of Staff card and a session card about a pull request, a card link followed twice with a refresh in between, and the strip's link beside a linked row only). The Work model, closeout and front-door tests still pass. Chromium at 390 and 1280 pixels: the Chief of Staff tag on the row, Why you under the recommendation in the opened card, no `cos:` key on screen. Full validation belongs to Local Verify before merge.
