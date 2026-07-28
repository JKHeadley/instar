# Side-Effects Review — Session Pool Track B (part 2c-wiring): server wiring + config knobs

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L2 (approved, review-convergence stamped)
**Track:** B part 2c (wiring) — instantiate the pool registry at server boot. Ships DARK.
**Files:** src/server/AgentServer.ts, src/commands/server.ts, src/core/types.ts, src/config/ConfigDefaults.ts

## What changed
1. **AgentServer:** new optional `machinePoolRegistry?` constructor option → passed straight into the RouteContext (`machinePoolRegistry: options.machinePoolRegistry ?? null`). Pure passthrough, mirrors `coordinator`.
2. **server.ts boot:** instantiate `MachinePoolRegistry` (guarded, best-effort try/catch so it can never break boot):
   - `listMachines` reads `coordinator.managers.identityManager.getActiveMachines()` → {machineId, nickname, hardware}.
   - `clockSkewToleranceMs` / `failoverThresholdMs` from config.
   - `recordSelfHardware(self, captureHardware())` once at boot (idempotent — only writes when changed).
   - A 30s **unref'd** interval re-records a self-heartbeat (so this machine shows online with live load) and feeds peer heartbeats from `MachineHeartbeat.listAll()` (peer liveness + the clock-skew FSM). Passed to AgentServer.
3. **Config knobs (types.ts + ConfigDefaults):** `SessionPoolConfig` gains `clockSkewToleranceMs` (300000), `maxExpectedNtpDriftMs` (250), `machineRecordEvictionMs` (86400000); added to the dark `multiMachine.sessionPool` ConfigDefaults block → migration parity (existing agents get them on update).

## Blast radius
- **Boot:** the registry block is fully wrapped in try/catch + every sub-step guarded; a failure logs `[pool] registry not wired` and continues — it cannot break server startup. The interval is `unref()`'d so it never holds the process open.
- **RouteContext:** `machinePoolRegistry` is optional → no other ctx builder affected. tsc clean across the repo.
- **Cost:** one registry instance + a 30s timer reading in-memory heartbeat records + `os.loadavg()` — negligible. `recordSelfHardware` writes the registry only when hardware changed (no steady-state sync churn).
- **Dark:** the registry is always instantiated for observability (GET /pool), but the session-pool BEHAVIOR (placement/transfer) stays gated by `sessionPool.stage` (dark). This wiring only powers the read-only /pool view + Machines tab.

## Risk + mitigation
- **Risk:** `coordinator.managers.identityManager` access at boot. **Mitigation:** guarded (`coordinator?.managers?.identityManager`); if absent (single-machine without a coordinator) the registry simply isn't wired and GET /pool reports `enabled:false`.
- **Risk:** the self-heartbeat interval drifting/erroring. **Mitigation:** wrapped in try/catch (best-effort); unref'd; 30s cadence.
- **Risk:** clock-skew tolerance vs NTP drift misconfiguration. **Mitigation:** defaults honor `tolerance ≥ 2× drift`; asserted in the ConfigDefaults test (the §L2 startup invariant).

## Migration parity
- The three clock knobs are in the `multiMachine.sessionPool` ConfigDefaults block → auto-applied to existing agents via `applyDefaults` (existence-checked, idempotent). Asserted in ConfigDefaults.test.ts.

## Rollback
- Remove the boot block + the AgentServer option/ctx field to revert; the config knobs are inert defaults. All dark.

## Tests
- tests/integration/pool-routes.test.ts (6, prior) covers the route+registry behavior the wiring exposes.
- ConfigDefaults.test.ts asserts the clock knobs + the `tolerance ≥ 2× drift` invariant. 27 green; tsc clean.
- The full-boot "GET /pool returns enabled:true on a live server" assertion rides the Track-H real-hardware E2E (booting real servers); the wiring is otherwise simple guarded passthrough. <!-- tracked: session-pool-track-b -->

## Agent awareness
- The CLAUDE.md Tier-0 blurb + Playbook trigger land with the Machines dashboard tab (next, the user-reachable surface), per the spec's Agent Awareness section. <!-- tracked: session-pool-track-b -->
