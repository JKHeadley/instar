---
title: machineAuth shared monotonic sequence (cross-transport replay fix)
slug: machineauth-shared-sequence
status: approved
review-convergence: 2026-05-31T05:35:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin directed
  building each multi-machine live-transfer cascade fix in-session on 2026-05-31
  (topic 13481), explicitly correcting any "leave it for a later pass" framing as
  a non-reason for an Instar agent. This is bug #3 of that cascade, found live
  after #1/#2 shipped (v1.3.140). The full fix ships in THIS PR. Flagged per
  cross-agent discipline.
---

# machineAuth shared monotonic sequence (cross-transport replay fix)

## Problem

Bug #3 of the multi-machine live-transfer cascade (after the lease-coordinator
wiring + effectiveView fixes shipped as v1.3.140). The live two-machine test
showed the laptop holds the lease and broadcasts it, but the standby's
`leaseHolder` stayed null — so MeshRpc still rejected transfers as `not-router`.

The mini's `security.jsonl` proved why: the lease broadcasts REACH the mini but
`machineAuthMiddleware` rejects them — `replay_detected: "Sequence
1780200440053 <= last seen 1780200440744 from <laptop>"`.

Root cause: `NonceStore.validate` enforces a monotonic sequence PER SENDING
MACHINE (one watermark per peer). But each machine-to-machine channel constructs
its OWN sequence counter, each seeded from `Date.now()` at construction
(`let leaseSeq = Date.now()`, `handoffSeq`, `markerSeq`, `liveTailWireSeq` in
server.ts; `this.machineSequence` in MessageRouter; etc.). Because the transports
are constructed at slightly different milliseconds during boot, their seeds
differ; whichever sends first with the highest seed sets the receiver's watermark,
and any channel with a lower seed (e.g. the lease broadcast, seeded earlier) is
then rejected as an out-of-order replay forever. The lease broadcast never lands,
so the standby never observes the holder.

## Goal

All of a machine's outbound machineAuth-signed requests share ONE process-global
monotonic sequence, so the receiver's per-machine watermark is never violated by
a different channel — eliminating the cross-transport replay collision.

## Non-goals

- No change to `NonceStore`'s replay model (per-machine monotonic sequence +
  nonce uniqueness + 30s timestamp window stay exactly as documented).
- No change to the on-the-wire signed-message format or headers.

## Design

Make `signRequest` (the single chokepoint EVERY machineAuth request flows through)
draw its sequence from a process-global monotonic counter
(`nextMachineAuthSequence()`), instead of the per-caller `sequence` argument. The
argument is retained for signature compatibility but ignored. The counter is
seeded from `Date.now()` so it stays monotonic across a process restart
(wall-clock only advances, so the receiver's persisted watermark from a prior run
is never above the fresh seed).

Chosen at the chokepoint (not threaded through each caller) deliberately: it is
impossible for any current OR future caller (lease, heartbeat, handoff,
reply-marker, live-tail, MessageRouter relay, CLI) to bypass it — which matters
because this cascade has repeatedly shown how easy it is to miss a caller.

## Testing

- `tests/unit/machine-auth.test.ts`: updated to the new contract (passed sequence
  ignored → process-global monotonic). Adds a regression — two channels signing
  via signRequest stay strictly monotonic (no collision) — and a direct NonceStore
  stale-sequence-rejection test (receiver behavior preserved). 21/21 green.
- `tests/integration/machine-routes.test.ts`: 23/23 green (no sequence regression).
- Tier-3: re-run the live two-machine transfer after deploy; the mini must now
  observe the lease (`leaseHolder` = laptop) and accept the forwarded session.

## Migration parity

Pure code in a shared function. No config/hook/route/CLAUDE.md change. Existing
agents get it on the v-next update.
