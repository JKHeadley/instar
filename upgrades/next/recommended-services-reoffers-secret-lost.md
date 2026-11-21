<!-- bump: patch -->
## What Changed

Recommended services re-offers, slice B: the `secret-lost` problem. At each server start the agent checks its loaded settings for a `{ "secret": true }` placeholder that the encrypted store couldn't fill, which means a secret the settings refer to is gone. That re-offers Bitwarden under the same limits. Which setting is missing never reaches a message or the ledger. Off behind `recommendedServices.reoffers.enabled`.

## What to Tell Your User

Nothing changes yet (off by default). When it's on, if the agent starts up and finds a saved password or key missing with no vault keeping a copy, it asks about Bitwarden once more, if you'd said no before.

## Summary of New Capabilities

- `secret-lost` re-offer source (boot check). No new routes.

## Evidence

- Unit and integration: `recommended-services-reoffers` tests (placeholder walk, depth bound, once per start, dark). E2E: production wiring records `secret-lost` once at start when enabled.
