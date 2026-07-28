# Side-Effects Review — Enforced Termination Watchdog (Postmortem F2)

**Version / slug:** `enforced-termination-watchdog`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (an autonomous-process KILL path + a new monitoring loop) — verdict appended at the end`

## Summary of the change

A new monitoring loop, `EnforcedTerminationWatchdog`, that **externally hard-stops an
autonomous run which has provably overrun its budget** — the counterweight to the
`AutonomousLivenessReconciler` (which keeps a run *alive*). It exists because on
2026-06-25 an autonomous run (topic 27515) with a hard 24h budget ran ~46h: the only
deadline enforcement was the run's OWN in-hook Stop-event check, which a wedged/looping
session never reaches, which an unbounded run has no budget for, and which fails toward
keep-running on an unparseable timestamp. This is "Structure beats Willpower" applied to
the END of work. Constitution: *The User Experience Is the Product* → sub-standard #2.

## What it touches (blast radius)

- **NEW files only for the logic**: `src/monitoring/enforcedTermination.ts` (pure
  predicate + two-tick confirmer), `EnforcedTerminationWatchdog.ts` (loop),
  `enforcedTerminationWiring.ts` (read adapters + audit). No existing module's behavior
  changes.
- **`src/commands/server.ts`**: constructs + starts the watchdog in the existing
  queue-started scope (alongside the reconciler). The durable-kill actuator **reuses the
  exact primitives the reconciler's `settleKill` already uses** — it adds NO new
  session-killing code path.
- **`AgentServer.ts` / `routes.ts`**: a function-typed status getter threaded for the
  read-only `GET /autonomous/enforced-termination` route. No mutation surface added.

## The dangerous side effect: it KILLS sessions. How it is bounded.

1. **Off by default, dry-run first.** `monitoring.enforcedTermination.enabled` is OMITTED
   from `ConfigDefaults` → the dev-agent gate resolves it (dark on the fleet); `dryRun`
   defaults `true` → it LOGS `would-terminate` and actuates NOTHING until a deliberate
   `dryRun:false`. A fleet agent is a strict no-op.
2. **Only a provable budget overrun.** `computeOverrun` fires solely on time-budget+grace,
   an absolute ceiling (26h), or an opt-in iteration ceiling — and gates OUT inactive,
   paused, and mid-move runs. It is NOT a pressure/idle reaper; it never kills a run inside
   its budget.
3. **Two-tick confirm.** A kill requires the SAME topic overrun on two consecutive ticks,
   absorbing a clock blip / an in-flight cooperative stop / a just-completed run.
4. **Fail-safe on uncertainty.** Every predicate failure (unreadable state, malformed
   snapshot, a `listRuns` throw) swallows toward NO actuation. The watchdog never kills on
   ambiguity.
5. **Per-window cap.** A flapping detector gives up LOUDLY (`cap-exceeded`, audited) rather
   than kill-loop (P19).
6. **The kill is durable AND non-reviving.** The actuator composes, in order: delete the
   state file (`stopAutonomousTopic`), record the operator-stop (`recordOperatorStop`),
   cancel queued resumes (`rq.cancelByTopic`), then clear `endedMidWork` and `killSession`
   (the reconciler's `settleKill` path). So neither the liveness reconciler nor the resume
   queue revives a deliberately-terminated run — and the generation guard still lets a
   genuinely-NEW run on the same topic start later.
7. **Full audit.** Every transition → `logs/enforced-termination.jsonl` (rotating). The
   guard posture is registered (`GET /guards`), so a silently-off watchdog is visible.

## What it does NOT do

- Does not touch legacy single-file (non-per-topic) jobs.
- A real termination is NOT silent (spec §3): the actuator posts one plain-English notice
  to the run's topic on a real stop ("I stopped the autonomous run … it ran past its time
  budget …"). It fires only outside dryRun (etTerminate is never called in dryRun), so a
  dark/dryRun agent emits nothing. Best-effort (a notice failure never blocks the stop).
- Does not change the cooperative in-hook duration check; it is the EXTERNAL backstop the
  grace window defers to.

## Rollback

Set `monitoring.enforcedTermination.enabled: false` (or leave it omitted) — the watchdog
is not constructed and the route 503s. No migration, no persisted state to unwind beyond
the append-only audit log.

## Second-pass reviewer verdict

**Concur with the review** (independent reviewer, 2026-06-26 — verified the artifact's claims
against the actual code, not just the prose).

Verified: `computeOverrun` returns null for `!active||paused||moveSuspended` BEFORE any time
check (enforcedTermination.ts:87); time-budget fires only at `elapsed >= duration+grace`; every
uncertainty path (listRuns throw, computeOverrun throw, audit throw) fails toward NO actuation;
the two-tick confirm is genuinely enforced (only `confirmer.reconcile()` output actuates, streak
resets when a topic drops out); the durable kill composes delete-state-file → recordOperatorStop
→ rq.cancelByTopic → clear endedMidWork → killSession in that order (server.ts etTerminate),
mirroring the reconciler's proven settleKill, so a terminated run is not revived; and it is
genuinely dark (absent from ConfigDefaults → not even constructed on the fleet) + dryRun-first
(the dryRun path audits then `continue`s, never calling terminate). Cap bounds actuations to 5
per ~2h window.

Residual observation (NON-blocking, intended semantics): a doubly-corrupt run (unparseable
`started_at` AND unreadable mtime → fileMtimeMs=0) classifies as past the absolute ceiling and
fails TOWARD a kill — the deliberate, spec-documented inverse of the 27515 "fails toward
run-forever" bug. It remains gated behind active+unpaused+not-moving + two-tick confirm + dryRun
+ dev-gate, so it is the intended fail-direction, not a hole — worth keeping visible when the §5
live-flip battery runs.
