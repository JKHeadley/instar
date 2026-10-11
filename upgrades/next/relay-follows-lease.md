# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The relay admits one connection per agent identity. On a multi-machine agent, whether a machine connected was decided once at boot from `multiMachine.telegramPolling === false`. A standby that left that flag unset connected with the shared identity and displaced the awake machine's relay (instar#2122, Luna's step 4a on 8 Oct; tracking ACT-1306 a). A standby that later took over the lease never connected at all.

- **The relay now follows the serving lease** when `threadline.relayFollowsLease` resolves on. `bootstrapThreadline` takes a live `relayOwner` predicate; the server passes "this machine holds the serving lease" (single-machine agents, with no lease, always own it). A machine that does not hold the lease at boot defers its connection and logs `relay connection deferred`. A 5 s check connects as soon as the machine takes the lease, and releases the connection after 3 consecutive non-owner checks, so a brief lease blip does not churn the relay.
- **A displaced non-owner no longer reclaims.** The 15-minute displacement reclaim is skipped when this machine is not the relay owner: the displacement was the awake machine taking its connection.
- **The relay-forward standby fact is kept current.** `relaySuppressedByStandby` on the relay-send route updates through `onRelayStandbyChange`, so a machine that released the relay forwards its sends to the holder. The bootstrap result also exposes a live `isRelayReleasedForStandby()`.
- **`/threadline/health` reports `relay.state: 'standby'`** (status ok) while this machine has released the relay to the lease holder, instead of `disconnected`/recoverable, which implied a retry that never happens.
- The explicit `multiMachine.telegramPolling: false` still suppresses the relay outright, as before.
- **Dev-gated.** `threadline.relayFollowsLease.enabled` omitted: on for a development agent, off on the fleet. Off keeps today's boot-time behaviour exactly.

## What to Tell Your User

If you run me on two computers, only the computer in charge now holds my connection to other agents, and it moves when the other computer takes over. Before, a backup computer could knock the one in charge off that connection, and a backup that took over never picked it up.

## Summary of New Capabilities

- `threadline.relayFollowsLease: { enabled? }`, dev-gated.
- `bootstrapThreadline` config: `relayOwner`, `onRelayStandbyChange`, `relayOwnerCheckMs`, `relayReleaseAfterChecks`; result: `isRelayReleasedForStandby()`.

## Evidence

- `tests/e2e/threadline/relay-follows-lease.test.ts`: two real bootstraps sharing one identity against a real `RelayServer`. Only the holder connects at boot and the standby never displaces it; the connection moves when the lease moves and back again; the old holder stays off past the displacement rearm window; without `relayOwner` the bootstrap connects at once as before.
