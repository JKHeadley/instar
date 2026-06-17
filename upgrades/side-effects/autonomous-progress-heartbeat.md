# Side-Effects Review — AutonomousProgressHeartbeat (liveness backstop for a silent-to-user autonomous run)

**Spec:** docs/specs/autonomous-progress-heartbeat.md (converged — 3 rounds, 6 internal reviewers + GPT-5.5 + Gemini-2.5-pro, review report at docs/specs/reports/autonomous-progress-heartbeat-convergence.md). **Constitutional principle served:** Structure > Willpower (converts "report every ~30m" from a prompt wish into a timer-driven backstop).
**Ships DARK** behind `monitoring.autonomousProgressHeartbeat.enabled` (omitted in defaults → the dev-agent gate resolves it live-on-dev / dark-on-fleet) **and dryRun-first**. Off everywhere by config until a deliberate flip. Single change of behavior even when live: it may ADD one hedged line to a topic; it never blocks, delays, or rewrites anything.
**Files:** src/monitoring/AutonomousProgressHeartbeat.ts (new), src/monitoring/autonomousHeartbeatScrub.ts (new), src/commands/server.ts, src/monitoring/sentinelWiring.ts, src/server/routes.ts, src/server/CapabilityIndex.ts, src/config/ConfigDefaults.ts, src/core/devGatedFeatures.ts, src/core/types.ts, src/core/AutonomousSessions.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates.ts, src/monitoring/ProxyCoordinator.ts, plus 3 test files.

## What changed

1. **AutonomousProgressHeartbeat.ts (new):** the watcher. On a tick it evaluates a cheap-first predicate chain for each active autonomous run: (#1) user-silence elapsed past `userSilenceThresholdMs`; (#2) NOT mid-machine-move (reads `movedTo`/`move_suspended_at` markers via AutonomousSessions); (#3) the run has been active on THIS machine ≥ one window (destination-warmup guard); (#8) the screen frame shows genuinely fresh output (reuses the silence sentinel's existing snapshot — no extra capture). Only when ALL hold does it emit ONE hedged, observational line. Per-run cooldown + widening backoff cap the volume (~handful over a 24h run).
2. **autonomousHeartbeatScrub.ts (new):** scrubs the "last observed activity" focus text for secrets/paths before it can appear in a user-facing line. Fail-closed: an unscrubable/empty focus suppresses the line rather than risk a leak.
3. **server.ts / sentinelWiring.ts:** constructs + starts the watcher behind the gate, mirroring the ActiveWorkSilenceSentinel wiring; shares the existing SubagentTracker snapshot rather than taking its own.
4. **routes.ts / CapabilityIndex.ts:** `GET /autonomous-heartbeat` read-only status (current runs, per-run cooldown/backoff, last-emitted), 503 when dark.
5. **ConfigDefaults.ts / devGatedFeatures.ts / types.ts:** the `monitoring.autonomousProgressHeartbeat` config block (enabled OMITTED → dev-gate; dryRun default true; thresholds), and the dev-gate registration.
6. **PostUpdateMigrator.ts / templates.ts:** migrateConfig adds the config block (existence-checked); the CLAUDE.md template gains the agent-awareness section + the proactive trigger.

## Blast radius

- **Config-gated, not wiring-gated.** With `enabled` resolving false (fleet) the watcher is constructed-but-inert — `start()` returns before scheduling a tick, so zero behavior change. On a dev agent it resolves live but `dryRun:true` makes it LOG "would emit" without sending — observe-mode before it speaks.
- **No new outbound path.** When it does emit, it routes through the EXISTING one-voice/dedupe send plumbing (the same path the other sentinels use), so it cannot spam or talk over another of my messages.
- **No new capture cost.** Predicate #8 reuses the ActiveWorkSilenceSentinel's existing screen snapshot (a convergence-review fix to an earlier design that took its own).
- **Reads only run-state files + the existing frame.** No whole-tree walk; cost is O(active runs) per tick, same class as the reaper.

## Risk + mitigation

- **Risk:** re-creating the "still working" filler the honest-progress work deliberately deleted. **Mitigation:** the wording is hedged + observational ("haven't posted in a while — last observed activity was X") and movement-gated (predicate #8) — never a bare-timer "still working" claim. All 8 reviewers flagged the first design; the shipped one is the rebuilt honest version.
- **Risk:** leaking internal text/secrets into a user line. **Mitigation:** autonomousHeartbeatScrub fail-closed — an unscrubable focus suppresses the line.
- **Risk:** a duplicate line during a cross-machine handoff (one-voice lock is machine-local). **Mitigation:** accepted bounded low-harm risk, written into the spec; predicate #2/#3 already suppress on a mid-move/just-warmed run, shrinking the window.
- **Risk:** flooding a long run. **Mitigation:** per-run cooldown + widening backoff cap → a handful of lines over 24h, not fifty.

## Migration parity

- `migrateConfig` adds the `monitoring.autonomousProgressHeartbeat` block (existence-checked; only missing fields). CLAUDE.md template gains the awareness section. No hook/skill/settings change. New agents get it via init; existing agents via the update path.

## Dark-gate line-map

- `ConfigDefaults.ts` adds the `monitoring.autonomousProgressHeartbeat` block with `enabled` OMITTED (resolved by the dev-agent gate) + `dryRun:true`. `node scripts/lint-dev-agent-dark-gate.js` stays clean (no hardcoded `enabled:false`).

## Rollback

- Revert the PR, or set `monitoring.autonomousProgressHeartbeat.enabled:false` (or leave dryRun:true). The watcher goes inert; no durable state to unwind (cooldown/backoff is in-memory). Byte-identical to pre-PR behavior when off.
