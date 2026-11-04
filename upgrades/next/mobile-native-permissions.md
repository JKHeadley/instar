<!-- bump: patch -->

## What Changed

The Instar iPhone app can now list permission slips and feature switches natively, and the owner's phone can approve or decline an agent's waiting authorization request and turn a feature switch on or off, each with a fresh Face ID or passcode check. Two read routes, `GET /mobile/permissions/slips` (waiting requests and active slips, this machine plus other online machines read-only) and `GET /mobile/permissions/features` (switches, this machine plus others read-only), answer an owner phone or the agent's token. Four write routes (`POST /mobile/permissions/challenge`, `/mobile/permissions/requests/:id/approve`, `/mobile/permissions/requests/:id/decline`, `/mobile/permissions/features/:id`) accept only an active owner phone with a configured dashboard PIN, over the machine's own TLS front or loopback, carrying the phone's presence-key signature over a single-use 60-second challenge that names the exact action (the approved proposal's hash, the shown consent disclosure's hash, the decline reason's hash). They run the console's own approve, decline and operator-switch code, extracted into shared functions; the console routes behave as before. The agent's token is refused on every write. Every write and refusal is recorded in `state/mobile-permission-actions.jsonl` beside the console's own records, which now also name the phone. The writes are dark on the fleet and live on a development agent (`mobilePairing.permissionActions.enabled`).

## What to Tell Your User

When the app update arrives and your agent turns this on, your agent's page in the app gets a Permissions section. You can see what agents are asking permission for and approve or decline it, and see the agent's feature switches and turn them on or off. Every change asks you to confirm, then asks for Face ID. Only your own phone can do this, and only for things the console with your PIN could do.

## Summary of New Capabilities

- The owner's phone can approve or decline an agent's waiting authorization request, Face ID-confirmed.
- The owner's phone can turn a feature switch on or off, Face ID-confirmed, seeing the same "your data" disclosure as the console before turning one on.
- Waiting requests, active slips and switches from other machines are shown read-only.

## Evidence

Unit tests: exact action lines and signed bytes, the challenge store (single use, expiry, binding, caps), the dev gate both sides, the summarizers (no fingerprints, Slack ids or proofs; caps keep the soonest-expiring rows; peers read-only and named), consent disclosure hashing, the allowlist (exactly six owner-only rules, no raw routes). Integration tests through the real device check: owner and bearer reads, MSP refused; approve, decline and switch with fresh proofs; replayed, expired, wrong-action, wrong-target, wrong-proposal, wrong-reason, wrong-value, wrong-device and console-ticket signatures refused; bearer, MSP, missing key, no PIN, LAN and fleet-dark refused and audited; a switch waiting in the chain sees the feature switched off. Production-path test: a phone paired and enrolled through the real routes approves a real request (a signed carrier mandate whose audit names the phone), declines another, switches a feature (discovery event `operator-switch`), the raw routes stay closed to it, and the console's PIN approve still works.
