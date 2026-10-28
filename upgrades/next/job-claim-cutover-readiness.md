---
bump: patch
---

## What Changed

The journal job-claim cutover now has a code-owned readiness floor. It stays on
the existing bus claim path, even if its feature flag is enabled, until peer
claim receive and pool-wide acquisition are implemented and tested together.
The machine heartbeat no longer advertises journal-claim support prematurely.
Claim completion and script attempt IDs follow the mechanism acquired for the
fire, so an old local lease cannot affect a bus-run result.

## What to Tell Your User

Scheduled jobs continue using their current claim path. This closes a possible
double-run risk in a multi-machine pool while the new claim authority is still
being built. Jev result decisions remain off.

## Summary of New Capabilities

- No new user action. The cutover now reports support only when its full
  cross-machine safety path is ready.

## Evidence

The production claim store has no peer receive caller or pool-wide atomic
acquisition. The lifecycle test checks that a coherent two-machine flag cannot
select a local-only journal claim; the unit wiring test checks both the claim
gate and heartbeat advert use the readiness floor.
Integration tests cover stale local claims on both completion paths.
