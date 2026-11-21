<!-- bump: patch -->
## What Changed

Recommended services re-offers, slice D: the `address-repeatedly-down` problem. Each tunnel transition into `exhausted` (its own self-heal gave up) counts as one outage, kept per machine. Three within 24 hours re-offers Tailscale, or Cloudflare once Tailscale is a yes or was already re-offered for this. Off behind `recommendedServices.reoffers.enabled`; with it off, outages aren't counted.

## What to Tell Your User

Nothing changes yet (off by default). When it's on, if the agent's web address goes down three times in a day without fixing itself, it asks about Tailscale (or a Cloudflare fixed address) once more.

## Summary of New Capabilities

- `address-repeatedly-down` re-offer source; a problem kind may name an alternate service. No new routes.

## Evidence

- Unit: outage window and alternate choice. Integration: three outages, a restart mid-count, spread outages, the Cloudflare alternate, switch off. E2E: a stand-in tunnel's lifecycle events reach the ledger.
