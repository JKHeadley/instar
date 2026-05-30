# Side-effects review — Mentor Autonomous-Fix Loop ("just be Echo")

**Spec:** `docs/specs/MENTOR-AUTONOMOUS-FIX-LOOP-SPEC.md`
**Change:** a config-gated GUARDIAN path on the mentor heartbeat that keeps one
full-tool Opus session alive on the manual dogfooding loop (assign → observe →
FIX as a fleet PR → report) instead of the haiku observe-and-log pipeline.
**Class:** mentor capability (off by default; opt-in per agent).

## What changed

- **`src/scheduler/MentorAutonomousGuardian.ts`** (new) — pure
  `runAutonomousGuardian(deps)` gate sequence + `buildAutoloopGoal(params)`
  deterministic goal prompt. No I/O; every side-effect injected.
- **`src/scheduler/MentorOnboardingRunner.ts`** — new `MentorAutonomousFixConfig`
  type + optional `MentorConfig.autonomousFix`; three optional guardian services
  on `MentorRunnerServices`; widened `MentorRunReason` + `sessionName` on
  `MentorRunResult`; `tick()`/`startTick()` route to the guardian when
  `autonomousFix.enabled` (regardless of `mode`); new private `autonomousTick`.
- **`src/config/ConfigDefaults.ts`** — `mentor.autonomousFix` dark default added
  to `SHARED_DEFAULTS`.
- **`src/server/AgentServer.ts`** — wired `loopSessionAlive`, `spawnLoopSession`
  (full-tool Opus spawn), `buildAutoloopGoal` into `buildMentorRunner`.
- **`src/core/PostUpdateMigrator.ts`** — CLAUDE.md mentor section gains the
  autonomous-fix paragraph (new-agent text + a content-sniffed parity paragraph
  for agents that already have the section).

## Blast radius

- **Observe-pipeline:** unchanged. The guardian is a separate branch reached only
  when `autonomousFix.enabled`. With the dark default, every existing agent runs
  exactly the prior code path.
- **`runMentorTick` (pure):** untouched — the guardian is a sibling module, not a
  modification of the tick core.
- **Config reads:** `readMentorConfigFromDisk` already spreads
  `{...DEFAULT_MENTOR_CONFIG, ...parsed.mentor}`; an absent `autonomousFix` reads
  as `undefined` → disabled. Safe for every config on disk today.
- **Session spawn:** the loop session uses the normal `spawnSession` path
  (full-tool, like a regular session) — no new spawn machinery. The only new
  behaviour is that, when ENABLED, the heartbeat can start a session; the four
  gates bound that.
- **Other subsystems / DB schema / HTTP routes:** none added or changed. The
  guardian rides the existing `/mentor/tick` + `/mentor/status` routes.

## What could break (and why it doesn't)

- **Spawn-storm of expensive Opus sessions?** The single-instance gate
  (`loopSessionAlive`) makes the heartbeat a no-op while a cycle is running; a
  cycle outlives many heartbeats. Budget + min-interval add two more bounds.
- **Enabled but no spawner wired?** Surfaces as `reason: 'spawn-failed'` with a
  clear message in `/mentor/status.lastResult.error` — never a silent no-op.
- **Autonomous code landing untested?** The spawned Echo passes the same husky +
  instar-dev + CI gates as an interactive developer; those are framework-agnostic.
- **`mode: 'off'` blocking it?** Intentional: the guardian is a distinct path that
  keys on `enabled && autonomousFix.enabled`, so `mode` (which gates only the
  haiku pipeline) does not disable it.

## Security

No new external input, network, auth, or fs surface. The loop session is spawned
through the existing SessionManager with the agent's normal tool grant. Spawning
is gated behind an opt-in dark flag.

## Migration parity

`mentor.autonomousFix` is in `SHARED_DEFAULTS`, so `migrateConfig`'s `applyDefaults`
deep-merge adds the dark sub-block to existing agents on update
(existence-checked). CLAUDE.md parity handled in `migrateClaudeMd`. No new job.

## Rollback

Set `mentor.autonomousFix.enabled: false` (or remove the block) — instantly back
to the observe-pipeline. Revert the commit to remove the code; no persisted state,
schema, or API contract is affected.

## Tests

48 mentor tests green across all three tiers (unit guardian + runner branch,
integration routes, E2E production-wiring spawn with the Opus model + full tools),
plus migration-parity unit tests. `tsc` clean.
