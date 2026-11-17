<!-- bump: patch -->
## What Changed

Conversations owner reads no longer rebuild and re-verify the whole graph history several times per request: `ConversationGraphReplicationRuntime.readView()` builds the retained projection and the inventory from one verified union and reuses it until a durable write, a peer stream change, an erasure, a readiness/lease/membership change or 15 s. Header custody and change-status lookups use the same view. On the live Studio a read took 3 to 9 s and held the server; now one pass per graph change. Separately, `ensureOwner` no longer awaits re-sharing the complete pin set with peers on every owner request once all pins are held (it runs in the background, at most every 30 s), so one slow or asleep machine no longer stalls every Conversations request on the other. Also fixed: after another machine briefly held the lease, a reservation it left for an operation already recorded elsewhere made every native tail-close refuse (`graph-native-tail-conflict`), holding all owner changes indefinitely; such a superseded reservation is now retired once the other writer's record is certified. Refused peer requests and held owner changes now log their reason once.

## What to Tell Your User

Conversations should feel quick now, including Accept all, and it keeps working while another machine is slow or asleep.

## Summary of New Capabilities

- Conversations reads answer in well under a second instead of several seconds.
- A slow or sleeping machine no longer freezes Conversations on the other machine.

## Evidence

`tests/integration/conversation-graph-read-view-cache.test.ts` (2 tests); graph-default integration tests (26) pass. Live Studio profile and a real two-machine Accept all with one machine frozen are in the PR.
