# Upgrade Guide — recommended-services-cloudflare-recipe

## What Changed

The eighth recommended-services setup recipe, `cloudflare-v1` (service `cloudflare-domain`), dark until its live proof: only an agent listing it under `recommendedServices.provingRecipes` reaches it. After a yes, the setup session gets a Cloudflare API token for one zone (the person's own account signed in through Secret Drop, or an account of the agent's own with a domain bought only after the person hears the price and says yes), asks which host name they want, and stores the token and host name as one JSON value through the key route (`POST /recommended-services/cloudflare-domain/key`; a bare token or an unusable host name is refused with 400). The server then does the whole Cloudflare job in `POST /recommended-services/cloudflare-domain/sync` (`src/recommended/cloudflareDomain.ts`, wiring in `routes.ts`): finds the zone, finds or creates a tunnel named `instar-<agent>`, points it at this server's port, writes a proxied CNAME to `<tunnelId>.cfargotunnel.com`, writes `tunnel: { enabled: true, type: 'named', token, hostname }` into this agent's config (relay and notice settings kept) and asks for a planned restart (`requestSupervisedRestart`). The check passes once `GET https://<hostname>/health` answers from the public internet. A fixed address the person already had is never replaced. A switch-off restores the previous tunnel block (a quick tunnel when there was none), removes exactly the DNS record and the tunnel setup made, deletes the stored value, requests a restart and, because this is a way in, waits until another route works.

## What to Tell Your User

Nothing changes for you yet. Soon an agent will be able to give itself a fixed public address on a domain you control after your yes: you hand it one sign-in through a private link, or agree to a price for a new domain, and it does the rest.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Cloudflare recipe (proving agents only) | `recommendedServices.provingRecipes: ["cloudflare-v1"]` on a throwaway or development agent |
| Token and host name | `POST /recommended-services/cloudflare-domain/key` with `{"token":…,"hostname":…}` as the plain-text body, from the setup session |
| The Cloudflare work | `POST /recommended-services/cloudflare-domain/sync` from the setup session; repeated daily by the existing refresh |

## Evidence

`tests/unit/recommended-services-cloudflare-recipe.test.ts` (value and names, real client against a fake fetch, check, sync, switch-off, brief), `tests/integration/recommended-services-cloudflare.test.ts` (yes → key → sync → restart → check → switch-off; a pre-existing address kept; the way-in hold), e2e dark/proving, wiring. Live proof pending the operator's decision on a domain or a test-domain purchase.
