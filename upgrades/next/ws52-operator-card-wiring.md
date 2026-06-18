<!-- slug: ws52-operator-card-wiring -->
<!-- bump: patch -->

## What Changed

Fixes the WS5.2 one-tap Approve card so it actually appears and works on the live dashboard. The previous release shipped the card's parts (renderers, payload builder, connector, enforcement) but never wired them into the dashboard controller, and the scan offer was missing the fields/agents the card needs — so the card never rendered on the real Subscriptions tab. This connects the pieces end-to-end: the scan offer is enriched server-side with the card fields + the FD2 agent pair (operator never types a fingerprint); the controller now POSTs the scan, renders the card as the Subscriptions panel's lead section, and wires the Approve tap → PIN-gated `issue-for-machine`. A new controller integration test drives the real flow (fetch scan → render → Approve → POST).

## What to Tell Your User

The one-tap "let another machine use this subscription" Approve card now actually shows up on your dashboard's Subscriptions tab and works with a single tap + PIN — no codes, no JSON. (It was missing its final wiring before, so it never appeared.)

## Summary of New Capabilities

- The WS5.2 one-tap account-follow-me Approve card is now live on the Subscriptions tab (renders from the scan offer, Approve issues the PIN-gated mandate). Dark on fleet / live on the dev agent, as before.

## Evidence

- `tests/unit/follow-me-controller-wiring.test.ts` — NEW; drives the real controller: POSTs the scan, renders the card into `els.followMe`, and on Approve-with-PIN POSTs `/mandate/issue-for-machine` with the server-resolved FD2 agents + PIN; refuses to POST with no PIN. 4/4 pass.
- Existing card + payload unit tests still green (47 tests total across the follow-me suite).
- `npx tsc --noEmit` clean.
