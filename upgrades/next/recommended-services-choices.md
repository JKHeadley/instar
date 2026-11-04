<!-- bump: patch -->

## What Changed

Instar now keeps a signed, append-only record of a person's yes or no for each recommended outside service, and it replicates across the agent's machines where machine sync is on: the coherence journal is live, this store is on, and journal replication is enabled. The route's `replicating` field says whether it is. Rows written while it was off go out at the next boot once it's on. A no stands until the person confirms a yes that names it, so clock skew and delayed sync can't undo a refusal. A no needs the dashboard PIN. Old declines of Cloudflare and Git backup carry over as offer suppression only. The old suggestion paths no longer offer those two features. No offers go out yet.

## What to Tell Your User

Your choices about outside services like Tailscale or Bitwarden are now saved in one place. On agents with machine sync switched on, they follow you across your machines. I won't start offering these yet. That comes once setup for each one is proven.

## Summary of New Capabilities

- `GET /recommended-services` shows the saved choice for each service.
- `POST /recommended-services/:id/no` records a no, with the dashboard PIN and an optional reason category.

## Evidence

`tests/unit/recommended-services-ledger.test.ts`, `tests/unit/recommended-services-wiring.test.ts`, `tests/integration/recommended-services-routes.test.ts` and `tests/e2e/recommended-services-alive.test.ts`. The e2e proves a real AgentServer answers 200, enforces the real PIN check, and keeps a no across a restart. Replication between two real machines has not been run live yet.
