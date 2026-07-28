# Side-Effects Review — AutonomousLivenessReconciler (self-heal a run marked active but with no live session)

**Spec:** docs/specs/autonomous-liveness-reconciler.md. **Constitutional principle served:** Structure > Willpower + "An autonomous run must outlive its session" — a level-triggered control loop replaces an edge-triggered heuristic that had a single-instant failure window.
**Ships DARK on the fleet** behind `monitoring.autonomousLivenessReconciler.enabled` (OMITTED in defaults → the dev-agent gate resolves it live-on-dev / dark-on-fleet) **and dryRun-first** (the component code-defaults `dryRun:true`). On the fleet the routes 503 and the loop never constructs/acts. On a dev agent the loop + route are live but only LOG "would respawn" until a deliberate `dryRun:false` flip.
**Files:** src/monitoring/AutonomousLivenessReconciler.ts (new), src/core/devGatedFeatures.ts, plus (pending in this branch) src/commands/server.ts, src/server/routes.ts, src/server/AgentServer.ts, src/config/ConfigDefaults.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates.ts, and the integration/e2e tests.

## What changed

1. **AutonomousLivenessReconciler.ts (new):** the level-triggered reconcile loop. Per tick it reads the active autonomous runs (reusing `activeAutonomousJobs` + `autonomousRunRemainingForTopic`), and for each evaluates 7 candidate criteria — active+remaining, NOT paused, NOT operator-stopped, NOT mid-machine-move, owned by THIS machine, NO live session, NOT already in the resume queue. A candidate must persist N consecutive ticks across a debounce window before action. Action = a respawn through the SAME spawn-with-resume primitive the ResumeQueueDrainer uses, bounded by a per-topic rolling-window cap (P19 loop brake) that gives up LOUDLY (one coalesced attention item) and posts one honest self-heal line.
2. **devGatedFeatures.ts:** registers `autonomousLivenessReconciler` (configPath `monitoring.autonomousLivenessReconciler.enabled`) so the dev-agent gate resolves it live-on-dev / dark-fleet.
3. **(pending) server.ts / AgentServer / routes.ts / ConfigDefaults / migrator / templates:** construct the loop behind the gate reusing the drainer's in-scope dep closures (`liveSessionForTopic`, `topicOwnerElsewhere`, `operatorStopSince`, quota), the `GET /autonomous/liveness` status route, the config block, and the migration + CLAUDE.md awareness.

## Blast radius

- **Config-gated + dryRun-first.** Fleet: `enabled` resolves false → the loop is never constructed, the route 503s, zero behavior change. Dev: `enabled` resolves true but `dryRun:true` → the loop runs and LOGS "would respawn" without spawning anything. Only a deliberate `dryRun:false` makes it actuate.
- **No new outbound path of its own.** A respawn reuses the existing spawn-with-resume primitive; the self-heal notice + the give-up attention item reuse the existing send/aggregated-attention plumbing.
- **Coordinates with, never races, the ResumeQueue.** Criterion 7 (not-already-queued) + the multi-machine ownership criterion ensure the edge-triggered queue stays first responder; the reconciler only catches what the queue missed, and only on the owning machine.
- **Cost is O(active runs) per tick** (reads run-state files + a tmux-liveness check), same class as the reaper. No whole-tree walk.

## Risk + mitigation

- **Risk:** the reconciler fights the reaper (respawns what was just deliberately killed). **Mitigation:** it acts ONLY when the run-state file still says active+remaining AND no operator-stop/pause is in effect — a deliberate stop sets those, excluding the run. Proven by the operator-stopped / paused unit cases.
- **Risk:** an infinite respawn loop on a run that keeps dying. **Mitigation:** the per-topic rolling-window cap (default 3/6h, durable across restarts) stops auto-respawn and raises ONE attention item. Proven by the loop-brake unit case.
- **Risk:** two machines both respawn the same run. **Mitigation:** the ownership criterion (only the owner reconciles) + the debounce window absorbing lease-move lag + the post-transfer closeout. Proven by the owner-elsewhere unit case.
- **Risk:** a transient gap (mid-recycle) triggers a needless respawn. **Mitigation:** the N-tick debounce across a window + criterion 7 (queue already handling it). Proven by the debounce-reset unit case.
- **Risk:** spawning under quota pressure. **Mitigation:** a per-respawn quota gate (skip + retry next tick). Proven by the quota unit case.
- **Direction of failure:** every dep read fails toward NOT acting (err toward "alive" / "owned elsewhere" / "stopped" / "queued"), so an uncertain read suppresses a respawn — the strictly-safe direction (a missed respawn is the status quo; a false respawn is bounded by the cap).

## Migration parity

- (pending) `migrateConfig` adds the `monitoring.autonomousLivenessReconciler` block (existence-checked); the CLAUDE.md template gains the awareness section + proactive trigger ("user asks why a run died / didn't come back"). devGatedFeatures registration is in. No hook/skill/settings change.

## Dark-gate line-map

- (pending) `ConfigDefaults.ts` adds the `monitoring.autonomousLivenessReconciler` block with `enabled` OMITTED (resolved by the dev-agent gate). `node scripts/lint-dev-agent-dark-gate.js` must stay clean (no hardcoded `enabled:false`); the golden-map drift-canary test will be updated for the new `enabled:`-free block's line shift.

## Rollback

- Revert the PR, or set `monitoring.autonomousLivenessReconciler.enabled:false` (or leave dryRun:true). The loop never constructs / never actuates; the durable cap-state file is inert. Byte-identical to pre-PR behavior when off.
