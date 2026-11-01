# Add an agent to the Instar iPhone app with a one-time link

<!-- bump: patch -->

## What Changed

An agent can now mint a one-time pairing link that adds it to the Instar iPhone app (TestFlight). `POST /mobile/pairing-codes` (Bearer) returns a single-use, 10-minute code and an `https://instar.sh/pair#v=1&o=…&c=…` universal link. The app redeems it at the public `POST /mobile/pairing-codes/redeem`, which returns the agent's API token and never an operator session, and only over the agent's own named tunnel (TLS or loopback, named tunnel active, matching Host). A failure limiter separate from the PIN's runs after the code lookup, so a valid link always works. Minting needs a named tunnel with a hostname that only this machine serves (registry check plus eight self-probes via `GET /mobile/pairing-codes/ping`). Codes are bound to the token in force at mint. `GET /mobile/devices` (`?scope=pool`) lists paired phones. instar.sh gains the `/pair` fallback page (QR, copy link, no network requests) and the `apple-app-site-association` file. Development-agent gated (`mobilePairing.enabled`); dark on the fleet until per-device revocable tokens exist.

## What to Tell Your User

On a development agent you can say "add yourself to my phone" and get a link: tap it in Telegram and the Instar iPhone app adds the agent after you confirm the address. No address or PIN to type. The link works once and expires in ten minutes.

## Summary of New Capabilities

- One-time pairing links for the Instar iPhone app (`POST /mobile/pairing-codes`), redeemed in the app.
- A list of paired phones (`GET /mobile/devices`).

## Evidence

Spec converged in 6 review rounds (internal subagents plus GPT-6 Astra each round). Unit (14), integration (10) and end-to-end (2) tests cover single use, expiry, rotation binding, the failure limiter not blocking a valid code, Host and relay refusals, the 409 cases, the absent operator session, the exact bearer exemptions and the 503 gate. A real mint → redeem round trip passes through the production server wiring.
