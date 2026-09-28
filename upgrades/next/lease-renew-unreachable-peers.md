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

A confirmation that arrives after the deadline is not thrown away: `broadcast()`
reports it once through an `onLateConfirm` callback, and
`LeaseCoordinator.adoptLateRenewal()` installs it only if it is still current
(same epoch, not suspended or released, no higher epoch, not older than an
installed renewal). A healthy peer that answers in ~10s keeps the holder serving.

A peer's verified `higher-epoch` ack is no longer dropped. The transport keeps the
highest such epoch (`higherEpochEvidence()`) and pulls that peer's signed lease
through the existing pull path. `holdsLease()`, `renew()` and the solo-captain
hold refuse any epoch below it, whether the ack arrived early, after another
peer's success, or after the deadline.

Epoch CAS, signatures, the monotonic self-fence and "no epoch advance on hold"
are untouched.

## Evidence

- `tests/unit/lease-renew-unreachable-peers.test.ts` covers first-confirm with a
  hanging peer, the deadline, and prompt failure on refusal. It also runs renew
  over a real transport in four cases: peers reachable (confirms fast), all
  unreachable and presumed gone (the preferred captain holds the same epoch
  inside the budget), unreachable but recently alive (self-fence applies), and a
  peer at a higher epoch (no hold). It also runs real signed acks over the
  production mesh path on a fake clock: four renewals with 10s acks keep the
  holder serving; with no confirmation the self-fence still lapses and a later
  ack does not revive it; a verified higher-epoch ack blocks the solo hold,
  fences beside a confirming peer, fences after early success, and fences after
  the deadline. The five new ack cases fail on the round-1 code.
- `tests/integration/lease-renew-unreachable-peer-sends.test.ts` runs the full
  `/telegram/reply` path through the real renew timer. Sends stay authorized with
  a dead peer beside a live one, and on the solo-held captain. They are held
  (409) when an unreachable peer is only recently silent. A peer whose every
  ack lands after the deadline keeps sends authorized. When a peer's signed
  higher-epoch ack lands after another peer's success, the send is held (409, no
  Telegram call). Those two cases fail on the round-1 code.

## What to Tell Your User

If one of your machines is switched off or can't be reached, the machine that
does the talking no longer goes quiet because of it. Before, one unreachable
machine could make replies stop for a while when the main machine was busy.

## Summary of New Capabilities

- Lease renewal returns as soon as one peer confirms, and within a bounded
  deadline otherwise (`HttpLeaseTransportDeps.broadcastDeadlineMs`).
