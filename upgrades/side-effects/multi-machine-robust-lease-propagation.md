# Side-Effects Review — Multi-Machine Robust Lease Propagation (active PULL)

**Version / slug:** `multi-machine-robust-lease-propagation`
**Date:** `2026-06-01`
**Author:** `echo`
**Second-pass reviewer:** `independent lessons-aware convergence review (2 passes → converged)`
**Spec:** `docs/specs/MULTI-MACHINE-ROBUST-LEASE-PROPAGATION-SPEC.md` (approved: true, approved-with-change)
**Parent principle:** `Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions`

## Summary of the change

Adds an **active lease PULL** path to the cross-machine fenced-lease layer, so a
standby is no longer blind on a quiet or one-way (NAT) network where the holder's
broadcast never arrives. The transport gains a `pullPeer`/`pullAllPeers` over the
authenticated channel (`POST /api/lease/pull`, machine-auth is body-hash based so a
signed empty body authenticates cleanly); the coordinator runs a constant-cadence,
jittered pull loop independent of holder liveness, folds a pulled higher-epoch lease
(auto-demoting a fenced holder) and surfaces a same-epoch contested split-brain
Near-Silently (logs + `getSyncStatus().splitBrainState='contested'`), which the
registry `awakeMachineCount` misses in a git-less mesh.

This is **build + test only**: the loop arms only when a pull-capable transport is
attached and multi-machine is configured; no production lease, stage, or config is
flipped by this change. The session-pool rollout `StageAdvancer` is now wired to a
**revert-only** reconcile tick (it can demote a live stage on a red E2E for the current
commit; promotion stays operator-triggered) and its commit SHA is boot-cached from git.

## Decision-point inventory

- `HttpLeaseTransport.pullPeer` returns the peer lease / `null` (network error, non-ok,
  or no lease are all advisory `null` — never thrown); a successful pull (even one
  carrying no lease) marks the medium reachable (bidirectional `isReachable`).
- `LeaseCoordinator.effectiveView` fold: a pulled lease overrides only when STRICTLY
  higher-epoch (same-epoch self-issued wins the tie) — the existing rule, unchanged.
- `surfacePullDiscoveredSplitBrain` contested vs clear: we still hold AND a raw observed
  peer lease names a different holder at our epoch → latch `contested` (rising-edge log).
- `StageAdvancer.reconcile` revert vs hold: red E2E for the CURRENT commit → revert one
  stage; otherwise hold (promotion is never automatic).

## 1. Over-block / over-act risk
The pull loop never ACTS on roles — it only folds observed leases and reconciles role to
`holdsLease()`. A pulled higher epoch demotes us (correct fencing); a same-epoch tie does
NOT demote (it surfaces as contested, the genuinely-unresolvable case the operator owns).
The reconcile tick can only demote a stage on a verified red, never advance.

## 2. Under-act risk
A quiet/one-way network previously left a standby blind (the bug this closes). The
constant cadence — independent of whether the holder looks alive — is the anti-blinding
guarantee; the startup invariant `leasePullIntervalMs < leaseTtlMs` ensures at least one
pull per lease lifetime.

## 3. Level-of-abstraction fit
The pull lives at the transport (wire) + coordinator (lease authority) layers — the same
layers that own broadcast/observe — not bolted onto a sentinel or prompt. The route is a
sibling of the existing `POST /api/lease` receive route.

## 4. Signal vs Authority
The pull is a LEARNING signal (folds observed state); the FencedLease epoch/signature
checks remain the sole authority for who holds. A pull cannot grant authority — only the
CAS/fence can. Split-brain surfacing is observability only (no auto-demote on a tie).

## 5. External surfaces
Adds `POST /api/lease/pull` (machine-auth gated; returns the responder's effective-view
lease, which may re-serve a third machine — there is intentionally NO holder==responder
guard since the puller re-verifies via `acceptTunnelLease`). No new outbound external
calls beyond peer pulls over the already-authenticated machine channel.

## 6. Interactions with existing primitives
`pullPeer`/`pullAllPeers` are OPTIONAL on the `LeaseTransport` interface, so existing
mock/git-only transports remain valid and `canPullPeers()` is false there (loop no-ops).
`leasePullIntervalMs` joins the resolved seamlessness config with a startup invariant,
de-conflicted from the existing `standbyPullIntervalMs` (git pull) by name and purpose.
The pull-tick reconcile reuses `reconcileRoleToLease`; the contested flag ORs into the
existing `getSyncStatus` split-brain computation.

## 7. Rollback cost
All additive + default-safe. The pull loop only arms with a pull-capable transport +
multi-machine config; `stop()` clears the timer (stopped-guard prevents resurrection from
an in-flight tick's re-arm). Disabling = set `leasePullIntervalMs` ≥ `leaseTtlMs` (caught
at startup) or run a git-only transport. No production lease/stage state is changed by
this commit.

## Migration parity
- `leasePullIntervalMs` is a code-defaulted (5s) optional knob resolved + validated in
  `seamlessnessConfig` (matches its siblings — not seeded into config.json), so existing
  agents get the default with no migration; a nonsensical value is rejected at startup.
- The CLAUDE.md dials note gains `leasePullIntervalMs` in BOTH the generator
  (`templates.ts`) and the migrator (`PostUpdateMigrator.ts` `migrateClaudeMd`) so new
  and existing agents both learn the dial.

## Tests
108 green across the touched area + 3 tiers: unit (`HttpLeaseTransport` pull cases,
`LeaseCoordinator` pull accessors + same-epoch masking, `seamlessnessConfig`
leasePullIntervalMs invariant, `MultiMachineCoordinator-leasePull` loop→contested),
integration (`machine-routes` `POST /api/lease/pull` serve/null/401), e2e
(`multi-machine-lease-split-brain` partition→two-awake→pull-converge-to-one over real
lease components + mock HTTP). `tsc --noEmit` clean. Test-writing caught a real bug: the
`buildAcquisition` 3rd arg is the NONCE not the epoch (the first draft built epoch-1
leases when it meant epoch-5), and the same-epoch split-brain only forms when the peer
lease appears AFTER local acquisition.

## Follow-up (CI shard 4/4, post-merge-with-main)

`initializeLease()` → `startLeasePullLoop()` called `leaseCoordinator.canPullPeers()`
unconditionally, which threw for an injected coordinator that does not implement the
pull API — the existing `multi-machine-coordinator.test.ts` partial double (`fakeLease`)
lacks it, and so would any build predating active-pull. Hardened the loop start with a
`typeof this.leaseCoordinator.canPullPeers === 'function'` guard so such a coordinator
simply skips the loop (the intended git-only-mesh / partial-double behavior) instead of
crashing. Caught by the full CI unit matrix (shard 4/4, both Node 20 and 22) after the
merge with main brought the existing coordinator test into scope; 28 multi-machine tests
green, `tsc --noEmit` clean.

Also regenerated the generated `src/data/builtin-manifest.json` (via
`npm run generate:manifest`): an earlier revert to drop version churn from the PR diff
left it stale at v1.3.154, but `builtin-manifest.test.ts` ("is up-to-date with current
source") compares against the regenerated manifest for current source (now v1.3.192
post-merge). No behavior change — it is a generated data file. (`esm-compliance.test.ts`'s
local `require()` findings are byte-identical to main and present on main, so they are
pre-existing and pass in CI — not introduced here.)
