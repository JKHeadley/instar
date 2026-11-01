# Add an agent to the Instar iPhone app with a link and a private code

<!-- bump: patch -->

## What Changed

An agent can mint a one-time pairing link (`POST /mobile/pairing-codes`, Bearer) that adds it to the Instar iPhone app. The link is an `https://instar.sh/pair#v=1&o=…&c=…` universal link. The app redeems it at the public `POST /mobile/pairing-codes/redeem` (named tunnel only, matching Host, separate failure limiter), sending its own Secure Enclave public key. The phone starts **pending**: the agent sends the owner a 6-digit code only in their private Telegram chat (with a Decline button), and the phone becomes active when that code is typed into the app (`POST /mobile/device/confirm`, device-signed). Active phones authenticate with low-S ECDSA signatures over a canonical string bound to their id and host, are limited to a fixed allowlist of idempotent requests, never receive the API token or an operator session, and can be revoked one at a time (`POST /mobile/devices/:id/revoke`). A shared budget of 10 wrong codes per 24 hours pauses pairing; a code seen in a conversation cancels its pairing; pending pairings expire on restart and on lease loss. `GET /mobile/devices` (`?scope=pool`) lists phones. instar.sh gains the `/pair` fallback page and the app association file. Development-agent gated (`mobilePairing.enabled`).

## What to Tell Your User

On a development agent you can say "add yourself to my phone" and get a link. Open it on your iPhone, then type the 6-digit code I send you privately in Telegram into the Instar app. Each phone has its own key, so you can switch one off without signing anything else out.

## Summary of New Capabilities

- One-time pairing links for the Instar iPhone app (`POST /mobile/pairing-codes`).
- Per-phone keys confirmed by a private code, revocable one at a time (`POST /mobile/devices/:id/revoke`), listed with `GET /mobile/devices`.

## Evidence

Both specs converged at the 6-round cap with GPT-6 Astra and internal reviewers each round. 44 tests: unit (code store, signatures incl. malleated high-S and replay, registry budget and failed-write behavior), integration (redeem → owner DM → signed confirm → signed reads, wrong codes, Decline, leaked code, lease loss, revoke scope, gate off), and end-to-end through the production server wiring.
