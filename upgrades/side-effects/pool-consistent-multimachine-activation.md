# Side-Effects Review — Pool-Consistent durableOwnership Activation (PR1: the predicate)

**Spec:** docs/specs/pool-consistent-multimachine-activation.md (CONVERGED iter 4, self-approved). **Tracking:** CMT-1568 follow-on. **Parent:** No Silent Degradation to Brittle Fallback.
**Earned from:** the live Laptop↔Mini transfer-fix proof (v1.3.589) — the fix was half-active because `durableOwnership` is per-machine dev-gated and the Mini's echo isn't dev-flagged.
**Files:** src/core/durableOwnershipActivation.ts (new), src/commands/server.ts, tests/unit/durableOwnershipActivation.test.ts (new), site/src/content/docs/architecture/live-user-channel-proof.md.

## What changed

1. **durableOwnershipActivation.ts (new):** a pure, testable activation predicate.
   `shouldActivateDurableOwnership(config, resolveDevAgentGate)` = `devGate || isPlacementReplicationEnabled(config)`, where `isPlacementReplicationEnabled` reads the explicit `multiMachine.coherenceJournal.replication.enabled === true` signal (the SAME one gating `journalSyncApplier` at server.ts:16588). Invariant: a machine consuming replicated placements runs the ownership applier + durable store.
2. **server.ts:14861:** replaced the inline `resolveDevAgentGate(durableOwnership.enabled)` gate with `shouldActivateDurableOwnership(config, resolveDevAgentGate)`; the boot log names the activation reason (`pool: replication-on` vs `dev-gate`).
3. **Tests:** 7 unit tests covering both sides of every boundary (non-dev+replication-on activates [the Mini case]; non-dev+replication-off stays dark; dev activates; single-machine no-op; explicit `=== true` required).

## Blast radius

- **Strictly WIDENS activation** from "dev agents only" to "dev agents OR any machine with placement replication explicitly on." A single-machine agent (no replication) is UNCHANGED (stays InMemory — strict no-op). A multi-machine agent that explicitly enabled `coherenceJournal.replication.enabled` now also runs the durable store (which it needs to materialize transferred ownership).
- The durable store is well-tested (18 tests + the live Laptop-side proof in v1.3.589). Activating it where replication is on is the SET that needs it; it never DEACTIVATES anywhere it was active.
- No new route, no config schema change, no migration. Reversible: revert the predicate to the dev-only gate.

## Risk + mitigation

- **Risk:** a machine activates the durable store but its peer (mid rolling-deploy, old code) doesn't → half-applied transfer. **Mitigation:** the applier already backfills (queries existing placements per tick); the capability-refuse guard (PR2 follow-on) fail-closes the deploy window; the split-active detector (PR3) surfaces residual inconsistency. For PR1 the predicate alone makes a same-version pool consistent.
- **Risk:** over-promotion past the dev ladder. **Mitigation:** it activates only where the operator EXPLICITLY enabled replication (`=== true`, absent by default) — operator opt-in, not automatic.

## Migration parity

- No config default added (the predicate reads existing flags). No CLAUDE.md template change (the durableOwnership awareness shipped with v1.3.589). The new class is documented in the architecture site doc.

## Dark-gate line-map

- UNCHANGED. No new `enabled: false` line in ConfigDefaults.ts. `durableOwnership` stays in DEV_GATED_FEATURES; this only BROADENS its activation predicate, it does not change its gate registration.

## Rollback

- Revert the predicate to `resolveDevAgentGate(durableOwnership.enabled, config)`. The durable files remain valid; the journal stays the source of truth.

## Evidence

- 7 new unit tests (both sides of every boundary), all green; tsc clean; the predicate directly closes the live finding (the Mini has `replication.enabled:true` → the predicate activates the durable store there). The live re-proof (a reply served from the Mini) is the acceptance criterion, run after deploy.
