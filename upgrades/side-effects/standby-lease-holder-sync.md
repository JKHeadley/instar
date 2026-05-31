# Side-Effects Review — Standby lease-holder propagation

**Version / slug:** `standby-lease-holder-sync`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Decouple cross-machine lease coordination from git. The lease coordinator +
`HttpLeaseTransport` (and the handoff / reply-marker / live-tail transports) now
run whenever `coordinator.enabled && coordinator.identity`, instead of being
nested inside a single `try` gated on `gitBackupEnabled` whose first statement
(`new GitSyncManager`) throws on an instar-source-tree home (SourceTreeGuard) and
discarded everything. Git-sync is now an internal best-effort optional; when no
git medium exists the lease uses a new `LocalLeaseStore` (local-file backed) and
the HTTP transport carries cross-machine propagation. Also fixes a self-rejection
in `LeaseCoordinator.effectiveView` (it passed the transport's self-inclusive
nonce watermark to `acceptTunnelLease`, rejecting the very lease it validated).

## Decision-point inventory

1. **`gitSyncRef` defined vs undefined** → `GitLeaseStore` vs `LocalLeaseStore`.
2. **`effectiveView` tunnel-fold** → accept the observed lease iff sig + git-floor
   + epoch-newer pass (nonce floor now excludes the lease's own holder).

## 1. Over-block

**What legitimate inputs does this reject?** None added. The lease coordinator now
runs in MORE cases (git-less machines) than before, not fewer. `acceptTunnelLease`
still rejects forged/below-floor/older-nonce leases (signature + git-floor +
replay checks all run); excluding the observed lease's own holder from the nonce
floor does not weaken this — the transport's `recordObserved` already dropped
replays on receive, and a forged lease is still caught by the signature check
before it is ever folded.

## 2. Under-block

**What does this still miss?** A git-less mesh inherits the tunnel's coordination
(RTT-bounded acquisition + observe-before-acquire), not git's shared CAS — so its
split-brain guarantees are exactly the documented tunnel-path guarantees, no
stronger. This matches the spec non-goal. In the current 1-awake/1-standby
topology the standby never acquires, so there is no acquisition contention to
resolve. When git IS available, `GitLeaseStore` (shared CAS) is still used.

## 3. Blast radius

- New file `LocalLeaseStore.ts` is only constructed when `gitSyncRef` is undefined
  (no git medium). On any git-backed agent the behavior is byte-identical to today
  (`GitLeaseStore` path unchanged).
- The `effectiveView` change runs for ALL lease-coordinator users (git and
  git-less). It only RELAXES a redundant nonce self-check; existing
  `LeaseCoordinator`/`FencedLease`/`HttpLeaseTransport` unit suites (51 tests
  across these + the new ones) stay green, confirming no replay-semantic
  regression.
- The server.ts restructure moves the lease/handoff/live-tail setup out of the
  git-gated `try`. A failure in lease setup is still caught (now with a
  "Lease/transport setup" message) so a single-machine agent is unaffected.

## 4. Rollback

Pure code (no migration, no config default, no schema). Rollback = revert the PR;
`lease-local.json` becomes inert (no reader). No data is mutated or deleted.

## 5. Failure modes

- `LocalLeaseStore` persist fails (disk) → logged, in-memory view still serves;
  cross-machine propagation continues over the tunnel. Never blocks boot.
- Git medium unavailable → caught, lease falls back to LocalLeaseStore. This is
  the intended path, not an error.
