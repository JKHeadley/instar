# Side-Effects Review — Session Pool Track C(3): /mesh/rpc route + boot wiring (L0)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L0 (approved). **Track:** C part 3 — completes Track C. Ships DARK (transport live; mutation handlers come from D/E/F).
**Files:** src/server/routes.ts, src/server/AgentServer.ts, src/commands/server.ts, src/core/types.ts, src/config/ConfigDefaults.ts

## What changed
1. **`POST /mesh/rpc` route (routes.ts):** parses a signed MeshEnvelope → `ctx.meshRpcDispatcher.dispatch` → maps `{ok,result}` or `{ok:false,reason,status}` (401/403/409/501). 503 when unwired. Auth is the ENVELOPE's own Ed25519 sig (dispatcher), independent of the Bearer middleware. `RouteContext.meshRpcDispatcher?` (optional).
2. **AgentServer:** optional `meshRpcDispatcher` option → RouteContext passthrough (mirrors machinePoolRegistry).
3. **server.ts boot (guarded):** constructs a `MeshRpcDispatcher` when a machine identity exists — verify adapter (`getSigningPublicKeyPem(sender)` + Ed25519 `verify`), `isRegisteredPeer` = `isMachineActive`, an age-pruned in-memory seen-nonce map, `routerHolder` = `coordinator.getSyncStatus().leaseHolder`, `ownerOf`/`placementTargetOf` = null (wired by D/E), and LIVE read-class handlers (`capacity-report` → registry capacities, `session-status` → self capacity). Mutation handlers register from D/E/F → no-handler (501) until then.
4. **Config:** `meshRpcClockToleranceMs` (30000) added to SessionPoolConfig + ConfigDefaults (migration parity).

## Blast radius
- `/mesh/rpc` is a NEW route guarded by the envelope's own Ed25519 signature + the dispatcher's verify/RBAC (independent of Bearer). Until a machine identity exists it's unwired → 503 (single-machine no-op).
- Boot block fully try/catch-guarded (`[mesh-rpc] dispatcher not wired` on failure) — cannot break startup. The seen-nonce map is bounded (age-pruned at >5000 entries).
- `ownerOf`/`placementTargetOf` are null until L3/L4 → `claim`/`release` correctly reject (`claim-unauthorized`) — honest (no ownership data yet), not a bug.

## Risk + mitigation
- **Risk:** the verify adapter mis-binding a key. **Mitigation:** reuses the exact `getSigningPublicKeyPem` + `verify` path machineAuthMiddleware uses for peer signatures; proven end-to-end with REAL Ed25519 keys over HTTP in the integration test.
- **Risk:** in-memory nonce set lost on restart (replay window across restart). **Mitigation:** acceptable for the dark read-class transport + the 30s timestamp tolerance bounds any replay window; a durable NonceStore-backed variant is a noted refinement (NonceStore.validate is sequence-oriented, doesn't fit the nonce-only model cleanly).

## Migration parity
- `meshRpcClockToleranceMs` in the `multiMachine.sessionPool` ConfigDefaults block → existing agents get it on update.

## Rollback
- Remove the route + AgentServer option + boot block to revert. Dark + guarded.

## Tests
- tests/integration/mesh-rpc-route.test.ts (6, feature-alive): a REAL Ed25519-signed capacity-report → 200; wrong-recipient replay → 401; non-router place → 403; replayed nonce → 200 then 409; forged sig → 401; malformed body → 400. Plus MeshRpc unit (21) + ConfigDefaults (27). tsc clean.

## Agent awareness
- Internal m2m infra; covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-c -->
