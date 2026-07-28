# Side-Effects Review — Peer quota propagation (finding A2)

**Version / slug:** `peer-quota-propagation`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The peer's `quotaState` (already in its session-status response via
getCapacity(self)) was parsed away on the receive side — same narrowing bug as
the #931 commitmentsAdvert drop. Now carried through `fetchPeerCapacity` ->
`PeerCapacity` -> `PeerPresencePuller.recordHeartbeat` -> pool registry, so the
router sees a peer's quota and quota-aware placement (#804) can avoid a
rate-limited peer (the original EXO failure).

## Decision-point inventory

One: carry the field or not. Carried, additively, with absent = not blocked.

## 1. Over-block

A correctly-reported `blocked:true` peer is now AVOIDED by placement where
before it was silently chosen. That is the intended behavior, not over-block:
the data is the peer's own self-report (the gemini quota-conflation lesson —
never another machine's file; this is the peer asserting its OWN state).

## 2. Under-block

An old peer that omits quotaState still reads as not-blocked (fail-open,
unchanged) — no regression, just no improvement for un-upgraded peers.

## 3. Level-of-abstraction fit

The field travels the SAME path the commitmentsAdvert/journalAdvert already
travel (session-status -> fetchPeerCapacity -> puller). No new transport, no
new endpoint. The serving side already emitted it (getCapacity spread).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Placement remains advisory + fail-open: a hard pin still wins
(pinned-machine-quota-blocked), all-blocked proceeds least-loaded. This change
only feeds the existing decision real peer data.

## 5. Interactions

- #804 quota-aware placement: the consumer — now has peer data.
- A1 (collector hoist): the producer — together they make placement real.
- gemini quota-conflation lesson: respected — this is the peer's OWN
  self-report carried verbatim, never this machine reading another's file.
- Old peers: forward/backward compatible (optional field).

## 6. External surfaces

`GET /pool` now populates a peer's `quotaState` (was always null for peers).
No new routes/config/notifications.
