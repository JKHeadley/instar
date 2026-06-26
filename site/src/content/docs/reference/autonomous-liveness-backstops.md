---
title: Autonomous Liveness Backstops
description: The two structural guards that keep a long autonomous run legible and alive — AutonomousProgressHeartbeat ("alive but quiet") and AutonomousLivenessReconciler ("dead but marked active").
---

A long autonomous run can fail the user in two distinct ways that look identical
from the outside (silence). Two complementary background guards close both —
each ships dark on the fleet (dev-agent gate) and dryRun-first on a development
agent.

## AutonomousProgressHeartbeat — "alive but quiet"

`AutonomousProgressHeartbeat` (`src/monitoring/AutonomousProgressHeartbeat.ts`)
is a hedged, change-gated, sparse liveness backstop. When an autonomous run has
gone silent to the user for a long stretch **while its terminal output is still
moving**, it posts ONE purely-observational line ("I haven't posted here in a
while — last observed activity was …"). It never claims "still working", never
fires on a bare timer, and is bounded by a long user-silence gate + a
corroborated recent output change + a per-topic cooldown + a widening per-run
backoff + a hard per-run cap + the shared one-voice lease. Signal-only.

- Read surface: `GET /autonomous-heartbeat` (503 when dark).
- Config: `monitoring.autonomousHeartbeat` (`enabled` omitted → dev-gate decides; `dryRun` defaults true).

## AutonomousLivenessReconciler — "dead but marked active"

`AutonomousLivenessReconciler` (`src/monitoring/AutonomousLivenessReconciler.ts`)
is a level-triggered control loop (the Kubernetes-reconciler pattern): it
continuously compares desired state (a run whose state file says active with time
remaining) against actual state (a live session is executing it) and converges by
respawning the orphaned run. It is the twin of the heartbeat — the heartbeat
covers "alive but quiet"; the reconciler covers the worse "gone, but the records
say I'm here" (the 2026-06-16 incident, where a topic-lookup returned null at the
reap instant and the active run silently died).

Safety mechanisms (hardened across four convergence rounds):

- **Root-cause fix** in the reap path: a null topic lookup falls back to the
  session-name parse, adopting it only when the run-state file confirms an active
  run — never resurrecting against a guess.
- **Bounded anti-reaper-thrash gate**: stands down under machine pressure, but
  the stand-down is bounded so a busy box can't leave a dead run dead forever.
- **Atomic claim + post-spawn settle-kill**: an operator stop issued during the
  async spawn always wins (the just-spawned session is terminally killed, its
  `midWork` tag cleared so the revival queue can't undo it).
- **Untrusted state file**: the working directory is realpath-resolved and jailed
  to the agent home; the resume UUID comes from the canonical resume map — both
  refuse loudly rather than spawn against an unsafe guess.
- **Separated give-up counters** (P19): infra-flake retries are bounded
  separately from the redie brake, which is unified with the resume queue's
  resurrection count; on give-up it raises ONE attention item.

- Read surface: `GET /autonomous/liveness` (503 when dark).
- Config: `monitoring.autonomousLivenessReconciler` (`enabled` omitted → dev-gate decides; `dryRun` defaults true).
- Audit: `logs/autonomous-liveness.jsonl`.

Constitutional anchor: **An Autonomous Run Must Outlive Its Session**.

## EnforcedTerminationWatchdog — "alive past its deadline"

The deliberate counterweight to the reconciler: the reconciler keeps a run *alive*;
the `EnforcedTerminationWatchdog` keeps a run from *outliving its budget*. Born from a
24h-budget run that reached ~46h (topic 27515, 2026-06-25) because the only deadline
enforcement was the run's own in-hook Stop-event check — which a wedged/looping session
never reaches, an unbounded run has no budget for, and an unparseable timestamp fails
toward keep-running.

The watchdog watches every run from the OUTSIDE. `computeOverrun` fires only on a provable
overrun — a time budget past its grace, an absolute ceiling (default 26h, which covers
unbounded runs and unparseable timestamps via file mtime), or an opt-in iteration ceiling —
and gates out inactive/paused/mid-move runs (it is never a pressure/idle reaper). A
`TerminationConfirmer` requires the overrun on two consecutive ticks before any kill. The
durable kill reuses the reconciler's `settleKill` (clear `endedMidWork` → `killSession`)
plus the state-file delete + operator-stop record + resume-queue cancel, so a terminated
run is not revived. Every predicate failure fails safe (no kill on uncertainty); a per-window
cap makes a flapping detector give up loudly rather than kill-loop.

- Read surface: `GET /autonomous/enforced-termination` (503 when dark).
- Config: `monitoring.enforcedTermination` (`enabled` omitted → dev-gate decides; `dryRun` defaults true; `graceSeconds` 120; `absoluteCeilingSeconds` 26h).
- Audit: `logs/enforced-termination.jsonl`.

Constitutional anchor: **The User Experience Is the Product** → sub-standard #2 Enforced Termination.
