# Upgrade Guide — NEXT (multi-session autonomy)

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

**New: instar can run multiple autonomous jobs at once — one per topic.**

Autonomous mode used to be one-at-a-time: a single `.instar/autonomous-state.local.md`
held the only job, and starting a second overwrote the first. Now each topic gets its own
state file at `.instar/autonomous/<topicId>.local.md`, so topic A and topic B run
independent autonomous jobs concurrently with no collision. The stop hook resolves its own
topic (tmux name → topic-session registry) and reads that topic's file — ownership is
implicit and survives restarts (building directly on the topic-keyed identity fix).

A legacy single-file job is still honored and migrated to the per-topic path on first touch,
so an in-flight job is never disrupted.

**Guardrails for running several long jobs at once:**

- **Concurrency cap** — `autonomousSessions.maxConcurrent` (default 5). A start beyond the
  cap is refused (enforced at start via `GET /autonomous/can-start`; local file-count backstop
  if the server is unreachable).
- **Budget gate (refuse-new)** — under quota pressure, new autonomous starts are refused
  (`QuotaTracker`); running jobs are not preempted. Any running job can be paused
  (`paused: true` → its hook allows exit until resumed).
- **Stop controls** — `POST /autonomous/stop-all` halts every job; `POST
  /autonomous/sessions/:topic/stop` halts one. An emergency-stop in a topic also clears that
  topic's autonomous job so it can't zombie-resume on the next session.
- **Visibility** — `GET /autonomous/sessions` lists every active job (topic, goal, iteration,
  paused). Registered in `/capabilities`.

## What to Tell Your User

I can now work on several things autonomously at the same time — one job per chat topic —
instead of just one. They don't step on each other, each survives a restart on its own, and
there's a cap (5 by default) plus a budget check so a pile of long jobs can't run away. You
can ask "what autonomous jobs are running?" any time, stop one, or stop everything at once.
Nothing to set up; existing agents get it on their next update.

## Summary of New Capabilities

- Concurrent per-topic autonomous jobs (`.instar/autonomous/<topicId>.local.md`).
- Concurrency cap (`autonomousSessions.maxConcurrent`, default 5) + quota refuse-new gate.
- Pause mechanism (`paused: true`) to shed a running job under pressure.
- `GET /autonomous/sessions`, `GET /autonomous/can-start`, `POST /autonomous/stop-all`,
  `POST /autonomous/sessions/:topic/stop`.
- Emergency-stop clears the topic's autonomous job (no zombie-resume).
- Legacy single-file job honored + migrated to per-topic automatically.

## Migration Notes

Existing agents receive the updated stop hook + setup script via
`PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` (multi-session marker), and the
CLAUDE.md multi-session awareness section via `migrateClaudeMd`. The `maxConcurrent` config
defaults to 5 in code, so no config edit is required. No action needed.

## Evidence

- **Unit:** `AutonomousSessions.test.ts` (13) — cap (allow/refuse/paused-don't-count),
  quota refuse-new, cap-before-quota, list, stop-all, stop-topic, pause.
  `autonomous-multi-session.test.ts` (6) — two-topic isolation (each hook blocks on its own
  file, neither touches the other), foreign-topic exit, restart-survives-per-topic, legacy
  fallback + migration, no-job→exit. Driven against the real hook.
- **Integration:** `autonomous-sessions-api.test.ts` (5) — the four routes over HTTP: list,
  cap refusal at 2, per-topic stop (then under-cap allows), 404 unknown topic, stop-all clears.
- **E2E:** `autonomous-restart-resume-lifecycle.test.ts` — full restart-resume on the
  per-topic file.
- **Migration:** `PostUpdateMigrator-autonomousStopHook.test.ts` — v1.2.55→multi-session hook
  upgrade, setup-script upgrade, idempotent, customized-untouched, wiring guard.
