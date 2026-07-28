# Side-Effects Review — Cross-Machine Seamlessness: G1 fenced-lease integration

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §6 + §8 G1 (converged, approved)
**Increment:** wire the FencedLease primitive into the live coordinator as the
authority for awake/standby — closing the Phase-0 split-brain structurally.

## What changed
- `src/core/LeaseCoordinator.ts` (new) — drives FencedLease over a durable store
  (+ optional tunnel): acquisition (bounded-retry CAS + livelock backoff),
  renewal with a medium-agnostic confirmation requirement, the `holdsLease()`
  fencing gate, epoch-advance signal, and unresolvable-split escalation. Tracks
  `selfIssued` (the holder's freshest self-signed lease) so a renewal's new
  expiry is honored without churning git.
- `src/core/GitLeaseStore.ts` (new) — durable CAS over git: pull-rebase →
  epoch-check → write → push-or-reject-reread (never force-push). `refresh()`
  does a same-epoch durable expiry bump and declines if superseded. Bumps the
  holder's syncSequence/authoredUnderEpoch so the lease write passes peers'
  replay guard.
- `src/core/GitSync.ts` — added `pullRebase()` (targeted, no auto-commit) for
  the lease CAS. Additive.
- `src/core/MultiMachineCoordinator.ts` — optional `leaseCoordinator`;
  `shouldSkipProcessing()` returns `!holdsLease()` when attached (the structural
  demotion Phase-0 lacked); `attachLeaseCoordinator` / `initializeLease` /
  `tickLease` / `reconcileRoleToLease`; the monitor tick drives the lease when
  attached (heartbeat retained for liveness display only).
- `src/commands/server.ts` — constructs the lease crypto (signs with the
  identity key whose pubkey is registered; verifies peers via the SAS-paired
  registry), the GitLeaseStore, and the LeaseCoordinator; attaches + initializes
  it; wires onEpochAdvance → `leaseEpochChange` (→ durable registry push).

## Over-block / under-block
- **Over-block:** `shouldSkipProcessing` now gates on `holdsLease()`. Risk: a
  single git-backed machine that briefly can't read its own lease would skip
  processing. Mitigated — a single machine acquires epoch 1 trivially at
  `initializeLease()` (no peer to contend), and `holdsLease` reads its own
  `selfIssued` lease (in-memory), not requiring git. Non-git / single-machine /
  independent-mode meshes have NO leaseCoordinator → fall back to the existing
  heartbeat path unchanged.
- **Under-block:** git-only (no tunnel) means lease transfer latency is bounded
  by git cadence, not RTT. Acceptable for the launch increment (Phase 0 proved
  pairing works over git alone). The split-brain SAFETY is preserved via the
  refresh-confirmation self-suspend (a partitioned holder stops within
  leaseTtlMs). The tunnel ACCELERATOR is a tracked follow-on, not a correctness
  gap.

## Signal vs authority
- Detectors emit signals (`checkForUnresolvableSplit`, sync-health); only the
  lease HOLDER mutates authority-bearing state. A non-holder fails its own
  fencing check and self-fences — no cooperative demotion needed.

## Interactions
- The lease epoch advance fires `leaseEpochChange`, which the G2 wireRegistrySync
  already subscribes → the new epoch is pushed durably. Closed loop.
- `reconcileRoleToLease` updates `_role` + StateManager read-only + heartbeat
  writer to match lease holding — keeps existing role-dependent code paths
  (scheduler `coordinator.isAwake`, etc.) coherent.
- Heartbeat failover logic is bypassed when a lease is attached (the lease is
  the single authority) — avoids two mechanisms fighting over role.

## Rollback cost
- Low–moderate. The lease is only active when git-backed multi-machine is
  enabled AND construction succeeds (inside the existing try/catch). Reverting
  the server.ts block + the coordinator's lease methods restores the
  heartbeat-only behavior; the new modules become dead code.

## Tests
- `tests/unit/LeaseCoordinator.test.ts` (real Ed25519): acquire, presumed-dead
  takeover, CAS contention yield, tunnel + git-only self-suspend, escalation,
  epoch-advance signal. FencedLease/config/wiring/replay suites still green (57
  total). Coordinator-integration + git-CAS-under-real-contention land in the
  Tier-3 e2e + the real-hardware gate.
