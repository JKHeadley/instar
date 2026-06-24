# Side-Effects Review — Mesh Coherence: Live-State Honesty

**Spec:** docs/specs/mesh-coherence-live-state-honesty.md (converged + approved — standing operator pre-authorization, Justin topic 27515, 2026-06-22 mandate). **Parent principle:** Signal vs. Authority.
**Fix (c) ships UNFLAGGED** (pure improvement to an existing boot-time warning). **Fix (b) ships DARK** behind `monitoring.meshCoherenceLiveCheck.enabled` (dev-gated: live-on-dev / dark-fleet). Single-machine agents are a strict no-op (the `isMultiMachine` guard + the multi-machine-only `peerPresenceTimer`).
**Files:** src/core/configCoherence.ts, src/commands/server.ts, src/core/types.ts, src/core/devGatedFeatures.ts

## What changed

1. **configCoherence.ts — Fix (c):** DROPPED the dead `.priorities`-dict check (it validated a key no type or default ever populates) and replaced it with a flat-key check (`priorityTailscale`/`priorityLan`/`priorityCloudflare`) for distinct-positive-integers, reusing the EXISTING codes `mesh-priority-nonpositive` / `mesh-priority-collision`. RETYPED `MultiMachineLike.meshTransport` as `Pick<MeshTransportConfig, 'enabled'|'priorityTailscale'|'priorityLan'|'priorityCloudflare'|'bindHost'>` (imported the canonical type) so the phantom dict cannot be reintroduced by a hand-edit (compile-time proof).
2. **configCoherence.ts — Fix (b):** NEW exported pure function `checkMeshLiveStateCoherence(mm, isMultiMachine, live, warmupGraceMs?)` + the `MeshLiveState` interface + the exported `MESH_WARMUP_GRACE_MS` const. b.1 fires `mesh-config-off-but-live-on` on config-off + a NOT-LOOPBACK live bind (boundWide, corroborated-only by self-entry presence); b.2 fires `mesh-config-on-but-live-inert` on config-on + zero advertised endpoints + uptime past the warmup grace. NO-LEAK invariant: never interpolates a peer endpoint VALUE (counts + the process-local bound-host only); `selfEndpoints` is a boolean presence signal.
3. **server.ts — Fix (b) wiring:** `let meshResolvedBindHost: string | undefined` at OUTER function scope (beside `let getSelfMeshEndpoints`), ASSIGNED inside the mesh-init block via `resolveMeshBindHost` from the SAME `meshBindActive` inputs the AgentServer bind callsite uses (boot constant). The existing one-line `peerPresenceTimer` arrow was promoted to a named `peerPresenceTick` callback; the live-coherence recheck is APPENDED to it AFTER `pullOnce()`, gated `resolveDevAgentGate(config.monitoring?.meshCoherenceLiveCheck?.enabled, config)`. Transition-only emit (`_meshCoherenceLastCodes` Set + level-triggered reset) + emitCap (`_meshCoherenceEmitCounts`) + half-open-breaker backoff (`_meshCoherenceConsecFailures` / `_meshCoherenceTicksSinceAttempt`, MAX_BACKOFF_TICKS=20) + a healthy→failing latch (`_meshCoherenceFailing`) that transition-gates the `error` metric. Per-feature metric `mesh-coherence-live` (kind:'event', fired/noop/error) via `getFeatureMetricsRecorder()`.
4. **types.ts:** added `meshCoherenceLiveCheck?: { enabled?; warmupGraceMs?; emitCap? }` to `MonitoringConfig` (next to `growthAnalyst`).
5. **devGatedFeatures.ts:** added the `meshCoherenceLiveCheck` DEV_GATED_FEATURES entry (configPath `monitoring.meshCoherenceLiveCheck.enabled`). OMITTED from ConfigDefaults per the dev-gate convention → no `migrateConfig` needed.

## Blast radius

- **Fix (c) is behavior-narrowing then -widening, never wrong.** The dict check was ALWAYS dead (the dict is `undefined` for every shipped config), so removing it changes nothing for any real config; the new flat-key check only ADDS a warning for a genuine operator mistake (collision / non-positive) that previously sailed through unwarned. Both surfaces are advisory log lines — never a boot reject.
- **Fix (b) is config-gated, not wiring-gated.** With `meshCoherenceLiveCheck.enabled` resolving DARK (fleet), the `peerPresenceTick` coherence branch is a strict no-op — the tick does exactly what it did before (`pullOnce()`). `meshResolvedBindHost` is computed at boot regardless (cheap, pure), but it is read only inside the gated branch.
- **No new HTTP route, no new outbound surface.** Per spec, the warnings ride the existing `console.log(pc.yellow(...))` log path + the per-feature metric in `/metrics/features`. No Attention queue, no Telegram, no new route.
- **Machine-local.** Each machine evaluates its OWN config vs its OWN live bind/endpoints. No cross-machine fan-out, no pool-scope read.
- **The peerPresenceTimer refactor is behavior-preserving.** The named `peerPresenceTick` calls `pullOnce()` first (unchanged), then the gated coherence branch; the timer is still `setInterval(..., 30_000)` + `unref()`. The peer-presence-wiring test was updated to pin the pull inside the named tick fn.

## Risk + mitigation

- **Risk:** a corrupt/mid-write registry read (`getSelfMeshEndpoints()` → `loadRegistry`) throws and crashes the 30s tick. **Mitigation:** the live read is wrapped in try/catch; on failure it emits a TRANSITION-GATED `error` metric (one row per failure episode, not per tick), advances a capped backoff (≤1 attempt per ~10 min), and leaves the transition state untouched (fail toward silence). A successful read auto-resets the backoff and the latch. Proven by the sustained-failure integration test.
- **Risk:** a hostile/garbage peer-written self-entry steers the warning text (the registry is git-synced + peer-writable). **Mitigation:** the no-leak invariant — `selfEndpoints` is consumed as a boolean `length > 0` presence signal ONLY; warning strings interpolate only counts + the process-local operator-derived bound-host. Proven by the no-leak unit test (a hostile `url` never renders).
- **Risk:** b.1 false-silenced on a specific `meshTransport.bindHost` override (the original is-wildcard bug). **Mitigation:** `boundWide ≡ NOT-loopback` (mirrors `resolveMeshBindHost`'s `isLoopback`), so a specific non-loopback bind (e.g. 192.168.1.50) still fires. Proven by the R2-M10 regression test.
- **Risk:** b.2 false-fires during the legitimate boot-warmup window. **Mitigation:** a monotonic `process.uptime()` gate (default 2 min, overridable via `warmupGraceMs`); a permanently-inert mesh (first advertise never lands) still warns ~2 min after boot. Proven by the below/past-grace + param-override tests.
- **Risk:** the divergence line re-logs every 30s tick (repeated-true-line anti-pattern). **Mitigation:** transition-only emit with a level-triggered reset + an optional `emitCap` ceiling. Proven by the transition-only + emitCap integration tests.

## Migration parity

- `meshCoherenceLiveCheck` is OMITTED from ConfigDefaults (the dev-gate convention) → `resolveDevAgentGate` reads the absence directly, so NO `migrateConfig` change is needed (a backfilled `enabled:false` would defeat the gate). Stated explicitly in the spec (Decision #2).
- No CLAUDE.md template change: this is a signal-only honesty fix to an existing internal boot check with no user-facing conversational surface (no route, no proactive trigger). The Agent Awareness Standard targets capabilities an agent surfaces to users; a more-honest internal log line is not one. (The docs-coverage ratchet for the new exported helper is handled in site/src/content/docs if it trips — see PR.)

## Dark-gate line-map

- UNCHANGED. `meshCoherenceLiveCheck` is OMITTED from ConfigDefaults.ts (no inline `enabled:` literal added there), so no `enabled:` line shifted. Verified: `node scripts/lint-dev-agent-dark-gate.js` → clean; `tests/unit/devGatedFeatures-wiring.test.ts` → green (the new entry resolves live-on-dev / dark-fleet against real ConfigDefaults).

## Rollback

- Fix (b): set `monitoring.meshCoherenceLiveCheck.enabled: false` (or leave dark on the fleet) → strict no-op. Full revert: remove the DEV_GATED_FEATURES entry + the types field + the server.ts wiring (restore the one-line arrow timer) + `checkMeshLiveStateCoherence`. Fix (c) is a pure improvement to an existing check; reverting it restores the dead dict check (not recommended).

## Tests

- `tests/unit/configCoherence.test.ts` — extended: Fix (c) flat-key validation (collision / zero / negative / float / Infinity / default-no-warn / single-key / dead-dict-ignored), Fix (b) both directions (b.1 wildcards + bindHost-override-flip MUST-fire + stale-self-entry-must-not-fire + corroboration-count + disabled-took-effect; b.2 below/past grace + on-and-advertising + warmupGraceMs param override; single-machine no-op; undefined no-throw; no-leak assertion).
- `tests/integration/mesh-coherence-live-check.test.ts` — the wiring STATE MACHINE: transition-only emit over 3 ticks + level-triggered reset, flag-DARK no-op, emitCap:2 ceiling, sustained-failure (one error row, never crashes, bounded re-probes, auto-recovery).
- `tests/unit/mesh-coherence-wiring.test.ts` — e2e/wiring tier: source-pins the inline wiring in server.ts (import, outer-scope let, resolveMeshBindHost assignment from the bind inputs, nested-?.enabled dev-gate, real live signals, both tuning knobs, the metric, the throw-safety try/catch, the existing boot call intact).
- `tests/unit/peer-presence-wiring.test.ts` — updated for the named-tick refactor (the pull now lives in `peerPresenceTick`).

## Agent awareness

- No CLAUDE.md template entry (signal-only internal honesty fix, no user-facing surface). <!-- tracked: mesh-coherence-live-state-honesty -->
