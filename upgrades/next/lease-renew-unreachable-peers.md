# Lease renewal no longer waits on an unreachable peer

## What Changed

`HttpLeaseTransport.broadcast()` used `Promise.all` over every peer, so one
permanently-unreachable peer (a rope that times out at `requestTimeoutMs`, 30s)
held every renewal past the 20s `withTickTimeout('lease-renew')` await, even
while other peers confirmed. Under event-loop starvation the preferred captain's
lease lapsed, and origin sends were refused as `destination-not-authorized`
(Mac Studio, 2026-09-27, ~30 min).

`broadcast()` now resolves `true` on the FIRST confirming peer and `false` once
every peer has settled unconfirmed or a new `broadcastDeadlineMs` passes
(default 8s; `server.ts` derives `min(8s, 40% of tickWatchdog.awaitTimeoutMs)`).
The "any one peer confirms" rule is unchanged. So `LeaseCoordinator.renew()`
always reaches its solo-captain hold and grace decisions inside the tick budget.
Epoch CAS, signatures, the monotonic self-fence and "no epoch advance on hold"
are untouched.

## Evidence

- `tests/unit/lease-renew-unreachable-peers.test.ts` covers first-confirm with a
  hanging peer, the deadline, and prompt failure on refusal. It also runs renew
  over a real transport in four cases: peers reachable (confirms fast), all
  unreachable and presumed gone (the preferred captain holds the same epoch
  inside the budget), unreachable but recently alive (self-fence applies), and a
  peer at a higher epoch (no hold). 6 of 7 fail on the old code.
- `tests/integration/lease-renew-unreachable-peer-sends.test.ts` runs the full
  `/telegram/reply` path through the real renew timer. Sends stay authorized with
  a dead peer beside a live one, and on the solo-held captain. They are held
  (409) when an unreachable peer is only recently silent. The two "stays
  authorized" cases fail on the old code.

## What to Tell Your User

If one of your machines is switched off or can't be reached, the machine that
does the talking no longer goes quiet because of it. Before, one unreachable
machine could make replies stop for a while when the main machine was busy.

## Summary of New Capabilities

- Lease renewal returns as soon as one peer confirms, and within a bounded
  deadline otherwise (`HttpLeaseTransportDeps.broadcastDeadlineMs`).
