# Side-Effects Review — Fix: active-pull must not demote a solo machine on a transient lease lapse

**Version / slug:** `fix-activepull-solo-demotion`
**Date:** `2026-06-02`
**Author:** `echo`
**Spec:** `docs/specs/MULTI-MACHINE-ROBUST-LEASE-PROPAGATION-SPEC.md` (approved: true) — corrects a regression in the active-pull it introduced (#668).
**Parent principle:** `Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions`

## Summary of the change

A one-condition fix to `MultiMachineCoordinator.tickLeasePull`: it now only calls
`reconcileRoleToLease('lease-pull')` + `surfacePullDiscoveredSplitBrain()` when a peer
lease was **actually observed** (`leaseCoordinator.observedPeerLease()` non-null).

### Why (live incident, 2026-06-02)

The active-pull loop (shipped in #668) reconciled the machine's lease role
**unconditionally** every `leasePullIntervalMs` (~5s). On a solo machine — one with no
reachable peers (the only registry peer was dead 3 days, no `lastKnownUrl`, so `peers()`
was empty) — every brief lapse of the 60s self-lease between renewals made
`holdsLease()` return false, so the pull loop flipped the machine to **standby** →
`StateManager` read-only → a standby write threw and (pre-#673) crashed the server in a
launchd restart loop (lease epoch climbed into the thousands). The crashing server is the
Telegram relay, so the operator saw silence. #673 already stopped the *crash* (read-only
write is now an isolated/recoverable uncaught-exception class); this PR removes the *root
cause* (the spurious demotion itself).

## Decision-point inventory

- `tickLeasePull` reconcile vs skip: reconcile only when `observedPeerLease()` is non-null.
  Pull is for LEARNING from peers; with no peer signal there is nothing to reconcile.
  Role/renewal for a solo holder stays with the heartbeat `tickLease` (which RE-ACQUIRES,
  not merely demotes).

## 1. Over-correction risk
Does gating on an observed peer break the real feature (a standby pulling a higher-epoch
holder must still demote)? No — that path records the holder's lease via `recordObserved`,
so `observedPeerLease()` is non-null and the reconcile runs exactly as before. Covered by
the retained "same-epoch contested" test.

## 2. Under-correction risk
A solo holder whose lease lapses is no longer demoted by the *pull* loop, but the 2-min
heartbeat `tickLease` still renews/re-acquires it — so role management is preserved, just
moved off the aggressive 5s pull cadence that caused the DoS.

## 3. Level-of-abstraction fit
The fix sits in the pull tick (the loop that caused the regression), gating on the
coordinator's existing `observedPeerLease()` accessor — no new surface.

## 4. Signal vs Authority
The pull remains a SIGNAL (observe peer leases); the FencedLease epoch/validity checks
remain the authority for who holds. The fix stops the signal loop from ACTING (demoting)
in the absence of any signal.

## 5. External surfaces
None. No route/config/schema change. `leasePullIntervalMs` unchanged.

## 6. Interactions with existing primitives
Composes with #673 (read-only-write no longer fatal) as defense-in-depth: #673 prevents
the crash; this prevents the wrong state that led to it. The heartbeat `tickLease` and the
acquire path are untouched.

## 7. Rollback cost
Trivial + safe: a single `if (observedPeerLease())` guard. Reverting restores the prior
(buggy) unconditional reconcile.

## Migration parity
None — pure code logic change, reaches existing agents on the normal dist update.

## Tests
`tsc --noEmit` clean. 45 multi-machine tests green, including a NEW regression
(`MultiMachineCoordinator-leasePull` — a solo holder whose self-lease lapses with no peer
observed stays awake + never goes read-only) and the retained same-epoch-contested test
(feature intact). Operational note: echo was reverted to solo mode during the incident
(machine identity moved aside); re-pairing its mesh is a separate, operator-gated step.
