# Side-Effects Review — Session Pool Track D(3): ownership wiring + MeshRpc handlers (L3) — Track D complete

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L3 (approved). **Track:** D part 3 — completes Track D. Ships DARK.
**Files:** src/core/MeshRpc.ts, src/core/SessionOwnershipRegistry.ts, src/commands/server.ts, src/server/routes.ts, src/server/AgentServer.ts

## What changed
1. **MeshRpc:** `MeshCommandHandler` now receives the full envelope (so handlers can use `env.nonce` for the per-session ownership CAS); dispatcher passes it.
2. **SessionOwnershipRegistry:** added `InMemorySessionOwnershipStore` (fast-forward CAS, single-machine-correct; the cross-machine git-backed store is the Track-H swap — the registry/FSM/CAS are store-agnostic).
3. **server.ts boot:** constructs the `SessionOwnershipRegistry` (in-memory store + a per-session nonce set), feeds `ownerOf`/`placementTargetOf` into the MeshRpc dispatcher RBAC (replacing the prior null stubs), and registers the place/claim/transfer/release MeshRpc handlers → the registry CAS. Guarded; dark.
4. **RouteContext + AgentServer:** `sessionOwnershipRegistry?` passthrough (for L4 placement + observability).

## Blast radius
- All within the existing guarded MeshRpc boot block (dark; built only when a machine identity exists). The mutation handlers route to the registry CAS; on a single machine the in-memory store is correct (no cross-machine contention). `/mesh/rpc` place/claim/transfer/release are now live (RBAC-gated); read-class unchanged.
- `MeshCommandHandler` signature change is additive (handlers may ignore the new `env` arg); the dispatcher + its tests updated.

## Risk + mitigation
- **Risk:** an unauthorized claim/place mutating ownership. **Mitigation:** TWO gates — MeshRpc RBAC (place→router, claim→placement-target) refuses at the door (403), THEN the registry CAS (FSM + fast-forward) is the correctness fence. Proven end-to-end: integration test shows non-router place → 403 (no ownership written), non-target claim → 403 (ownership unchanged), router-place→target-claim → ownerOf reflects.
- **Risk:** single-machine in-memory store ≠ cross-machine durability. **Mitigation:** correct for single-machine + dark v0.1; the git-backed cross-machine store is a tracked Track-H-proof swap (store is an injected seam) — see decision D10.

## Migration parity
- No new config (meshRpcClockToleranceMs already in ConfigDefaults from Track C). The ownership store is in-memory (no persisted config).

## Rollback
- Remove the registry construction + handler wiring from the boot block + the ctx field to revert. Dark + guarded.

## Tests
- tests/integration/session-ownership-mesh.test.ts (3, feature-alive): router place→target claim→ownerOf reflects; non-router place → 403 not-router (no write); non-target claim → 403 claim-unauthorized (ownership unchanged) — real Ed25519 over HTTP. Plus SessionOwnership (11) + SessionOwnershipRegistry (6) + MeshRpc (21). tsc clean.

## Agent awareness
- Internal ownership/mesh layer; covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-d -->
