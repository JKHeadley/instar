# Side-Effects Review — Session Pool Track D(2): SessionOwnershipRegistry (L3)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L3 (approved). **Track:** D part 2 (the per-session CAS registry). Ships DARK (no server wiring yet).
**Files:** src/core/SessionOwnershipRegistry.ts (new)

## What changed
- **`SessionOwnershipRegistry.ts` (new):** the distributed per-session ownership registry. `cas(action, ctx)` runs the §L3 FSM transition (SessionOwnership.applyOwnershipAction), the per-session replay check (ownershipNonceKey), then the durable fast-forward CAS via an injected `store.casWrite` (the git single-ref push, mirroring GitLeaseStore). On a lost CAS (peer advanced first) → `cas-lost` + observed record; the nonce is recorded ONLY on a landed CAS. `ownerOf`/`placementTargetOf` (the §L4 RBAC reads), casConflicts/casRetryExhaustions metrics, and `ownershipRetryDelayMs` (lowest-machineId-first ordering HINT — never the arbiter; the remote ref-update decides). Store + nonce store are injected seams.

## Blast radius
- **None at runtime yet** — nothing constructs the registry. The server wiring (instantiate with a git-backed store + the per-session NonceStore + feed `ownerOf`/`placementTargetOf` into the MeshRpc dispatcher RBAC + register the `claim`/`release` handlers) lands in part 3. Pure additive module; reuses the proven GitLeaseStore CAS discipline per-session.

## Risk + mitigation
- **Risk:** split ownership under cross-machine contention. **Mitigation:** the CAS is the §L−1 single-ref fast-forward — exactly one candidate fast-forwards from epoch e; the loser is rejected non-fast-forward and observes the winner's e+1. Tested with a FakeStore that simulates a peer landing mid-flight: the loser gets `cas-lost` + observed the winner's record (NOT chosen by machineId).
- **Risk:** replay re-opening a window. **Mitigation:** per-session nonce key {sessionKey,sender,epoch} (tested: same nonce across two sessions both land; replay within a session caught); nonce recorded only on a landed CAS.
- **Risk:** retry storms. **Mitigation:** `ownershipRetryDelayMs` bounded exponential jitter; lowest-machineId-first is an ordering hint only.

## Migration parity
- None in part 2 (pure module, unwired). The CAS retry/backoff + clock-tolerance config knobs land with the server wiring (part 3) via the `multiMachine.sessionPool` ConfigDefaults path.

## Rollback
- Additive + dark + unwired. Delete SessionOwnershipRegistry.ts to revert.

## Tests
- tests/unit/SessionOwnershipRegistry.test.ts (6): place→claim lands + ownerOf; two-machine CAS at epoch+1 → one wins via ref-update + loser cas-lost + observed-the-winner; per-session nonce isolation (same nonce, two sessions, both land); FSM rejection propagated (out-of-sequence claim); retry-delay ordering hint bounded. tsc clean.

## Agent awareness
- Internal ownership layer; covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-d -->
