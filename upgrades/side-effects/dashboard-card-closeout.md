# Side-Effects Review — Close a work card from the console as Done or Not important

**Date:** 2026-11-17
**Author:** Echo
**Independent reviewer:** fresh general-purpose reviewer against the server code at this base. No wrong tap found; it confirmed `closeout.tapId` is always in `archives`. Its four findings are fixed: a close refused from the opened card now returns to the note step with the note kept and the reason shown; fixtures use the real Done-closed shape (`status: archived`, `lane: done`); a close in force counts as closed whatever the status reads (no Answer or Put on hold on an `unknown` closed card); Reopen's confirm text says when an older archive keeps the card archived. Left as is: a confirmed-done card (no close) offers Done and Not important where it used to offer Archive, which the server accepts.
**Tier:** 1, console client for the approved work-front-doors §6 close (server side PR #3394, which this branch builds on).

## Decision-point inventory
Which buttons a card offers, and what a close sends. A card from a server that can record a close (it names `turn`) offers **Done** and **Not important** in place of the plain Archive; a card still waiting for approval offers only Not important, since nothing is done yet. A closed card offers one **Reopen**, an `unarchive` naming `closeout.tapId`; the claim's own reopen is not offered beside it. Every close goes through the existing person-tap path: what it covers, then the dashboard PIN. The server remains the authority: it refuses an empty note (`note-required` / `reason-required`), an over-long one and one carrying a credential, and the console says each refusal in words.

## Over-block and under-block
The console refuses an empty or over-2000-character note before the PIN prompt, using the server's own words, so no PIN is spent on a close the server would refuse. It never accepts something the server would refuse. An older server (no `turn`) keeps the plain Archive, because that server ignores the note and would close the card without it.

## Level of abstraction
Button choice, tap body and confirm lines live in work-model.js beside the existing actions; work.js adds one note step before the existing confirm/PIN flow. Turn colours are CSS classes from the server's `turn` value. No new store, route or request type.

## Signal versus authority and judgment
No authority change. The agent still cannot close a card (the server refuses a non-person tap). docs/signal-vs-authority.md applies unchanged.

## Interactions and external surfaces
Web console Work page only. The iPhone, Mac and Android apps are separate client work (owned by the app session). The noteless Archive stays for older servers; retiring it is tracked under CMT-1803. The card strip on the conversation page (decision 3) is a separate follow-up.

## Multi-machine posture
The console is served by the machine it talks to, so a new console meets a server that names `turn`. Mixed versions are covered by PR #3394's own notes.

## Rollback
Revert the static asset change. No data repair: closes already recorded stay valid server data.

## Verification
21 new cases in console-work-closeout.test.ts (buttons per state including an unreadable closed card and an older-server close, tap bodies, note limits, confirm lines including two archives, refusal words, close line, turns, and five page flows in jsdom including a refused close from the opened card); the existing 42 Work model cases still pass (63 total). Chromium at 390 and 1280 pixels against the shipped dashboard: light red for "waiting on you", light blue for "with the agent", no Done before approval, the note step refuses an empty note and clears its warning once text is typed, the close is sent with `closeAs` and the note after the PIN, and a closed card shows Reopen; no sideways scroll, no page errors. Full validation belongs to Local Verify before merge.
