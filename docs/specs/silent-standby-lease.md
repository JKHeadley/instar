---
title: Silent-standby git-less lease coordination (observe-only + legacy-key fallback)
slug: silent-standby-lease
status: approved
review-convergence: 2026-05-31T08:50:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin put Echo in a
  12-hour autonomous run on 2026-05-31 (topic 13481) to iterate the multi-machine
  live-transfer cascade to fully working, step-by-step. This is bugs #4 + #5 of
  that cascade, both found + diagnosed live with instrumentation. Flagged per
  cross-agent discipline.
---

# Silent-standby git-less lease coordination (observe-only + legacy-key fallback)

## Problem

Bugs #4 + #5 of the multi-machine live-transfer cascade (after v1.3.140's
coordinator-wiring + v1.3.143's machineAuth-sequence fixes). Even with those
deployed, the standby (mini) still never resolved the lease holder, so MeshRpc
kept rejecting the forwarded transfer as `not-router`. Diagnosed live by adding
debug logging to the mini's `/api/lease` handler + `LeaseCoordinator.effectiveView`:

- **Bug #4:** the mini's lease setup threw at boot — `ENOENT … signing-key.pem`.
  Its machine key was stored under the pre-canonical-rename name
  `signing-private.pem`; `MachineIdentity.loadSigningKey()` reads only the
  canonical `signing-key.pem`. Constructing the `HttpLeaseTransport`
  (`signingKeyPem: idMgr.loadSigningKey()`) threw → the lease-try caught it → the
  `LeaseCoordinator` NEVER ATTACHED on the mini → `currentHolder()` fell back to
  null. (The mini's other key consumers had the key loaded a different way, which
  is why presence/machineAuth still worked — masking this.)

- **Bug #5 (split-brain):** with the key fixed and the coordinator attached, the
  mini STILL rejected the laptop's lease — `effectiveView … accept=false
  reason=below-git-floor (msg epoch 105 < committed 106)`. The role is DERIVED
  from the lease (hold lease → become awake) and lease acquisition is UNGATED, so
  at boot — before observing the laptop's broadcast — the mini acquired its OWN
  lease, then (with the git-less `LocalLeaseStore`, which has no shared
  compare-and-swap) both machines independently re-acquired and LEAPFROGGED epochs
  (mini at 106, laptop at 105/107). The mini's own higher epoch dominated its
  effectiveView, so it rejected the laptop's lease as below its own floor.

## Goal

A `telegramPolling:false` silent standby cleanly resolves the primary as lease
holder (so it authenticates the primary's router-only MeshRpc commands and can
receive a transferred session), with no split-brain leapfrog and no boot-time
ENOENT abort — on any agent regardless of which name its signing key was stored
under.

## Non-goals

- No change to the git-backed CAS path (`GitLeaseStore`) when git is available.
- No auto-failover for a silent standby (a muted standby becoming awake-yet-not-
  serving is incoherent; failover for it is a deliberate un-mute → telegramPolling
  true, at which point it's a normal acquirer). Auto-failover for the active-active
  pool is a separate concern.
- No change to `NonceStore`, `acceptTunnelLease`, or the wire format.

## Design

1. **`MachineIdentity.loadSigningKey()` legacy fallback** — on ENOENT for the
   canonical `signing-key.pem`, fall back to the legacy `signing-private.pem` if
   present (else rethrow). Fixes the boot abort for any legacy-keyed agent
   fleet-wide. (The lifeline loader already had this fallback; `loadSigningKey`
   did not — #546 lineage.)

2. **Silent standby = lease-observe-only** — add
   `MultiMachineCoordinator.isLeaseObserveOnly` (`config.multiMachine.telegramPolling
   === false`). In `initializeLease` and `tickLease`, a silent standby SKIPS
   `acquireIfEligible`/`renew` entirely — it never holds its own lease, so its
   `LocalLeaseStore` stays empty (epoch 0) and `effectiveView` folds the primary's
   observed broadcast → `currentHolder` resolves to the primary. This removes the
   boot-race self-acquisition that caused the leapfrog. (Maps the operator's
   explicit "silent standby" designation to coherent lease behavior.)

## Deploy note

A machine that already self-acquired a stale lease (the mini's epoch-106
`lease-local.json`) must have it cleared on deploy (`rm lease-local.json`), so its
store starts empty and folds the primary. (The fix prevents re-creating it.)

## Testing

- Tier 1: `machine-identity.test.ts` — loadSigningKey falls back to the legacy
  name; still throws when neither exists. `multi-machine-coordinator.test.ts` —
  a silent standby never acquires/renews (initializeLease + tickLease); a normal
  machine does acquire; `isLeaseObserveOnly` reflects the flag. 109 related tests
  green (machine-identity, coordinator, LeaseCoordinator, mesh-signing-key,
  syncstatus).
- Tier-3: re-run the live two-machine transfer after deploy — the mini's
  leaseHolder must resolve to the laptop and the forwarded session must be served.

## Migration parity

Pure code (new getter + a fallback + acquisition gate). No config default / hook /
route / CLAUDE.md change. Existing agents get it on the v-next update.
