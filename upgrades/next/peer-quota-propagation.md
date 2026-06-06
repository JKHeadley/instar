# Quota-aware placement can now see a PEER's quota, not just its own

## What Changed

Quota-aware placement is meant to route work away from a rate-limited machine.
But each machine only ever knew its OWN quota: a peer's quota state rides the
session-status response (the peer's own capacity already includes it), yet the
receive side parsed it away — the exact same narrowing bug that previously
dropped the commitments advert (#931). So the router could avoid placing onto a
rate-limited LOCAL machine but never onto a rate-limited PEER — which is the
original EXO failure (the laptop placing work onto a rate-limited Mini).

The peer-capacity parse + the PeerPresencePuller now carry `quotaState` through
to the pool registry. Absent from an older peer = treated as not blocked
(fail-open, unchanged).

## What to Tell Your User

If one of your machines hits its usage limit, the other machine now actually
knows and stops sending new work to it — instead of finding out the hard way.

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- `PeerCapacity.quotaState` carried from the session-status response through
  `fetchPeerCapacity` and `PeerPresencePuller` into the pool registry.
- `GET /pool` now shows a peer's `quotaState`, not just the local machine's.
- Pairs with finding A1 (the collector that produces the data now runs on
  lifeline-driven agents).

## Evidence

- `tests/unit/peer-presence-puller.test.ts` (+2): a peer quotaState propagates
  into the recorded heartbeat; an old peer omitting it records no quotaState
  (fail-open). 13/13 in file incl. the existing wiring suite.
- Live (pre-fix, v1.3.384): laptop `/pool` shows its own `quotaState:{blocked:false}`
  but the Mini's stays `null` after 5+ minutes despite the Mini's `/quota`
  reading `status:ok`.
