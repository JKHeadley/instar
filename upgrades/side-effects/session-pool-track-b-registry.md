# Side-Effects Review — Session Pool Track B (part 2a): Machine-Pool Registry

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L2 (approved, review-convergence stamped)
**Track:** B part 2a (the live machine-pool registry foundation). Ships DARK (no route/UI/wiring yet).
**Files:** src/core/MachinePoolRegistry.ts (new), src/core/types.ts

## What changed
1. **Types (types.ts):** `MachineHardware` (platform/arch/cpuModel/cpuCores/totalMemBytes/hostname/instarVersion), `ClockSkewStatus` (`ok` | `divergence-detected-once` | `suspect-clock-removed`), `MachineCapacity` (the live per-machine record — nickname + liveness + load + sessions + hardware + clockSkewStatus). All additive.
2. **`MachinePoolRegistry.ts` (new):**
   - `captureHardware()` — pure-ish `os` reads → MachineHardware.
   - `clockSkewTransition()` — PURE FSM implementing the §L2 transition table (2-divergent-beats-out / 2-clean-beats-in); `isPlacementEligibleByClock()`.
   - `MachinePoolRegistry` class — records heartbeat observations (stamps `routerReceivedAt` on the ROUTER's clock, runs the clock-skew FSM, fires `onClockQuarantine` on removal), and assembles `MachineCapacity[]` (the data behind GET /pool). Liveness keys on `routerReceivedAt`, NEVER the machine's self-reported time (§L2 clock-skew safety).

## Blast radius
- **None at runtime yet.** Nothing instantiates `MachinePoolRegistry` — it ships dark, exercised only by its unit tests. Wiring (server instantiation + heartbeat feed) and the `GET /pool` / `PATCH /pool/machines/:id` routes land in part 2b; the Machines dashboard tab in part 2c. The types are additive (optional fields, new interfaces).

## Risk + mitigation
- **Risk:** clock-skew FSM correctness (a wrong transition could wrongly quarantine or fail to quarantine). **Mitigation:** the FSM is a pure function with a test covering BOTH sides of every transition (1-divergent-then-clean forgiven; 2-divergent removed; 2-clean re-admitted; removed+divergent stays removed). 13 tests green.
- **Risk:** liveness fooled by a fast machine clock. **Mitigation:** liveness computed from `routerReceivedAt` (router's own clock at heartbeat arrival), tested explicitly (a far-future self-reported time still reads online by router clock, then offline once the router clock passes the threshold).

## Migration parity
- No config/migration in 2a (no new persisted config; the registry is in-memory, rebuilt from heartbeats). The clock-skew tolerance / NTP-drift config knobs land with the wiring (2b) under the `multiMachine.sessionPool` block via the ConfigDefaults path.

## Rollback
- Additive + dark + unwired. Delete `MachinePoolRegistry.ts` + the three §L2 types to revert; nothing depends on them yet.

## Tests
- tests/unit/MachinePoolRegistry.test.ts (13) — captureHardware, the full clock-skew FSM (both sides of each boundary), liveness-by-router-clock, assembly (nickname/capabilities from registry + load from heartbeat), quarantine→re-admit flow, unseen-machine handling. tsc clean.

## Agent awareness
- Deferred to part 2b/2c (the route + dashboard tab — the first user-facing surface), where the CLAUDE.md Tier-0 blurb + Playbook trigger land per the spec's Agent Awareness section. <!-- tracked: session-pool-track-b -->
