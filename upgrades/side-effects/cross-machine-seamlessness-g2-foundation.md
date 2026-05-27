# Side-Effects Review — Cross-Machine Seamlessness: foundations + G2 auto-sync

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md (converged, approved)
**Increment:** type/config foundations, the FencedLease primitive (logic), and G2
automated state sync with the named wiring + pull-side replay/freshness guard.

## What changed

New, self-contained modules (no behavior wired into existing flows except the two named seams):
- `src/core/seamlessnessConfig.ts` — resolve + validate the §9 tunable knobs; auto-derives
  `standbyPullIntervalMs = min(failoverThresholdMs/4, leaseTtlMs/2)` to satisfy BOTH cross-knob
  invariants (the bare `/4` the spec first stated violated the `< leaseTtlMs` invariant at default
  ratios — caught by the unit test; spec table corrected to match).
- `src/core/FencedLease.ts` — pure lease logic (epoch CAS candidate, signing/verify, fencing check
  `holdsValidLease`, `effectiveEpoch = max(tunnel,git)`, tunnel accept guard, presumed-dead
  acquisition, livelock backoff). Transport-agnostic; not yet wired into the coordinator (that is the
  G1 integration step).
- `src/core/RegistrySyncDebouncer.ts` — debounced, single-writer durable registry push + sync-health
  signal.
- `src/core/wireRegistrySync.ts` — the NAMED G2 wiring (coordinator roleChange/leaseEpochChange →
  markRegistryDirty), extracted as a testable seam.
- `src/core/registryReplayGuard.ts` — pure replay/freshness + epoch-floor + unknown-key-first-commit
  validator.

Edits to existing files:
- `src/core/types.ts` — additive optional fields on `MachineRegistryEntry` (syncSequence,
  authoredUnderEpoch, protocolVersion, rejoined), new `LeaseRecord`, optional `lease` on
  `MachineRegistry`, and the seamlessness knobs on `MultiMachineConfig`. All optional → no existing
  caller breaks.
- `src/core/GitSync.ts` — `sync()` snapshots the registry before pull and calls a new
  `reconcilePulledRegistry()` after a successful pull to scrub stale/unauthorized entries. Additive;
  on any error it warns and continues (never blocks sync).
- `src/commands/server.ts` — validates the seamlessness config at startup (rejects a violating
  config), constructs `gitSync` for BOTH roles (so a self-electing standby can push), and wires the
  RegistrySyncDebouncer. Stops it on shutdown.

## Over-block / under-block
- **Over-block risk:** startup config validation throws on a violating override. Mitigated: default
  and absent configs resolve to valid values (unit-tested), so only an explicitly bad override fails —
  which is the intended "reject, don't degrade silently" behavior (spec §9).
- **Under-block risk:** the replay guard only runs when `registryBefore` was readable and the pull
  changed HEAD; a first-ever pull with no prior registry simply trusts the incoming (no local baseline
  to compare). Acceptable — signed-commit verification still applies, and the unknown-key constraint
  still rejects an unknown machine asserting awake.

## Level-of-abstraction fit
- The durable push lives in a debouncer (coarse, registry-only), NOT in the per-tick heartbeat path —
  honoring the ephemeral/durable split so steady-state produces ~0 commits.
- FencedLease is pure logic with injected crypto; the transport (git/tunnel) is the coordinator's job.
  This keeps the dangerous CAS/fencing logic unit-testable.

## Signal vs. authority
- RegistrySyncDebouncer is single-writer: it only pushes when `isAuthoritative()` (awake / lease
  holder). A standby marking dirty is a no-op push — removes the O(N) thundering-herd.
- The replay guard and sync-health are SIGNALS (reject an entry / flip health); the authority to act
  on unhealthy sync (self-suspend ingress) belongs to the lease layer, wired in the G1 step.

## Interactions
- `gitSync` now constructed for standby too. It does NOT pull/push at boot unless awake (the boot
  `sync()` stays gated on `isAwake`); construction alone has no side effects beyond signing setup.
- `reconcilePulledRegistry` writes back a cleaned registry only when something was rejected — normal
  pulls are untouched (no spurious writes).
- The lease object in the registry is explicitly NOT reconciled by the guard (the FencedLease epoch
  CAS owns it) — avoids two components fighting over the same field.

## Rollback cost
- Low. New modules are unreferenced except the two seams in server.ts/GitSync.ts. Reverting the
  server.ts wiring + the GitSync snapshot/reconcile block restores prior behavior exactly; the new
  files become dead code. No schema/migration shipped in this increment (config knobs are read with
  defaults; migrateConfig lands in P4).

## Tests
- `tests/unit/FencedLease.test.ts` (real Ed25519), `seamlessnessConfig.test.ts`,
  `registry-sync-wiring.test.ts` (incl. the Phase-0-catching "role change triggers a push" test),
  `registryReplayGuard.test.ts`. All green. Tier-2 (real git repo) reconcile + Tier-3 land in P5.
