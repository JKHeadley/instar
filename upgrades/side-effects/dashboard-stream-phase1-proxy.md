# Side-Effects Review — Pool dashboard streaming phase 1 (PeerStreamProxy)

**Version / slug:** `dashboard-stream-phase1-proxy`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

A NEW, self-contained module (`PeerStreamProxy`) — phase 1 of the converged
POOL-DASHBOARD-STREAM-SPEC. The per-peer upstream relay state machine, with all
external surfaces (transport, timers, clock) injected. NOT wired into the live
WebSocketManager or server boot in this phase, so it has zero runtime effect
until phase 2 consumes it.

## Decision-point inventory

The state machine's transitions: open / multiplex / idle-close / reactivate /
bounded-reconnect / second-drop-unreachable / reconnect-timeout / url-change /
no-url. Each is covered both-sides by a deterministic test.

## 1. Over-block

N/A — no gating; a relay. The conservative reconnect policy (one attempt per
episode, then machine-unreachable) could declare a flaky-but-recoverable peer
unreachable, but the user simply re-subscribes (re-click), which opens fresh
and resets the budget. Storm-proof beats persistent.

## 2. Under-block

Keystrokes are never queued across a (re)connect — stale input is worse than
none. Acceptable: the dashboard shows the live link state (phase 3) so the user
knows when input is live.

## 3. Level-of-abstraction fit

Pure module under src/server/, no I/O of its own. The WebSocketManager (phase 2)
owns local clients + the browser WS and injects the transport; this owns only
the single upstream link + its bookkeeping. Matches the P2 precedent of
shipping a tested building block before its consumer.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority. A transport relay; all auth (ticket) + input gating
(allowRemoteInput) live in phase 2 at the WSManager/upgrade boundary per spec
§2.3.

## 5. Interactions

- WebSocketManager (phase 2): the future consumer; unaffected now (no import).
- Local polling loop: untouched — remote subs never enter it (TAP POINT). This
  module does no tmux capture.
- P19 (No Unbounded Loops): the reconnect is a single bounded attempt; tests
  assert the second-drop and timeout both terminate to machine-unreachable.

## 6. External surfaces

None in this phase. No routes, config, notifications, or wiring. A new source
file + its test only.
