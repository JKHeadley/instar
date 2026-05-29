# Side-Effects Review — Session Pool Track B (part 2b): /pool API + hardware

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L2 (approved, review-convergence stamped)
**Track:** B part 2b (the /pool HTTP surface + hardware self-attestation). Ships DARK (registry unwired in server until 2c).
**Files:** src/core/types.ts, src/core/MachineIdentity.ts, src/server/routes.ts

## What changed
1. **`MachineRegistryEntry.hardware?` (types.ts):** new optional field — a machine's self-attested static hardware (`MachineHardware`), synced to peers via the registry. Additive, backward-compatible.
2. **`MachineIdentityManager.recordSelfHardware(machineId, hardware)` (MachineIdentity.ts):** writes the machine's own hardware into its registry entry. Caller-supplies the hardware (manager stays free of `os`/assembly concerns). Idempotent — only writes when changed (avoids registry churn/sync on every boot); no-op for an unknown id.
3. **Routes (routes.ts):**
   - `RouteContext.machinePoolRegistry?` — optional dep (null/absent ships dark; existing ctx builders unaffected).
   - **`GET /pool`** — router holder (from `coordinator.getSyncStatus()`) + `MachineCapacity[]` (from the registry). Always 200; `enabled:false` + empty view when unwired.
   - **`PATCH /pool/machines/:id`** — `{ nickname }` → `identityManager.updateNickname` (via `ctx.coordinator.managers.identityManager`). 200 ok / 400 malformed-or-collision / 404 unknown / 503 single-machine. Metadata-only — never moves a session or touches lease/ownership.

## Blast radius
- **Routes are additive + Bearer-auth-protected** (the global server auth middleware; verified the router itself carries no auth, matching every other instar route — the integration test mounts the router bare and exercises it). `GET /pool` reads only `coordinator.getSyncStatus()` (already exists) + the registry; `PATCH` calls the already-tested `updateNickname`.
- **`machinePoolRegistry` is OPTIONAL** in RouteContext → no existing ctx construction site breaks (tsc clean across the repo).
- **`recordSelfHardware`** only writes when hardware changed — no extra registry-sync churn on steady-state boots.
- Production wiring (server instantiates the registry + feeds heartbeats + calls recordSelfHardware at boot) lands in part 2c alongside the Machines dashboard tab; until then `GET /pool` reports `enabled:false`.

## Risk + mitigation
- **Risk:** `PATCH` reaching through `ctx.coordinator.managers.identityManager`. **Mitigation:** guarded (503 when coordinator/idMgr absent — single-machine install); the underlying `updateNickname` enforces format + uniqueness (rejects collisions). Error mapping verified (400/404/503) by the integration test.
- **Risk:** hardware field on a synced registry record. **Mitigation:** optional + self-attested + advisory-only (never authority); `recordSelfHardware` idempotency prevents sync churn.

## Migration parity
- The `hardware` field is optional + auto-populated by `recordSelfHardware` at boot (wired in 2c) — existing registries get it on the next boot; absent until then (handled as optional everywhere).

## Rollback
- Additive + dark + (registry) unwired. Remove the routes + the optional ctx field + the hardware field/method to revert; no data migration to undo.

## Tests
- tests/integration/pool-routes.test.ts (6) — the "feature alive" surface: GET /pool 200 with router holder + machine capacities (nickname/hardware/liveness/clock-status); PATCH renames + GET reflects; 400 malformed; 400 collision; 404 unknown; 400 non-string. (This is the Tier-2/3 surface deferred from Track A per decision D5.)
- tests/unit/machine-nickname.test.ts — recordSelfHardware (stores; idempotent-when-unchanged; unknown-id no-op). 74 manager tests green; tsc clean.

## Agent awareness
- The CLAUDE.md Tier-0 blurb + Playbook trigger land with part 2c (the dashboard tab + server wiring — the moment the surface is user-reachable), per the spec's Agent Awareness section. <!-- tracked: session-pool-track-b -->
