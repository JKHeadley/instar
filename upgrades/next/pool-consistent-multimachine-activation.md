# Pool-Consistent durableOwnership Activation (the transfer fix, made to work cross-machine)

## What Changed

The cross-machine transfer fix (shipped dark in v1.3.589) was caught half-active by its own live test: the durable ownership store only turned on for a dev-flagged machine, so on a non-dev pool machine it stayed off and a transferred conversation died on arrival. This activates the durable store wherever placement replication is explicitly on (`multiMachine.coherenceJournal.replication.enabled === true`) — the pool-consistent signal — so it comes up on every machine that needs to materialize transferred ownership.

## What to Tell Your User

Nothing changes in normal single-machine use. For a multi-machine setup with replication enabled, the cross-machine "move a conversation between machines" feature now actually completes the move on the receiving machine — the gap the live test caught.

## Summary of New Capabilities

- `durableOwnership` activates wherever placement replication is on (not only dev machines); single-machine agents unchanged (strict no-op).
- New testable predicate `src/core/durableOwnershipActivation.ts`.

## Evidence

The live Laptop↔Mini proof of v1.3.589 found the Mini's durable store dark (its echo wasn't a dev agent) → ownership never materialized → seat died on arrival. The Mini HAS `coherenceJournal.replication.enabled:true`, so the new predicate activates the durable store there. 7 unit tests (both sides of every boundary) green; the live re-proof (a reply served from the Mini after a transfer) is the acceptance criterion.
