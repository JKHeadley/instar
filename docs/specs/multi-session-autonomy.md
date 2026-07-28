---
title: Multi-session autonomy (concurrent per-topic autonomous jobs)
date: 2026-05-23
author: echo
review-convergence: internal-plus-conformance-2026-05-23
approved: true
approved-by: Justin
approved-via: Telegram topic 12143 ("approved" 2026-05-23, after locking cap=5 / per-topic-stop-v1 / quota=refuse-new+pause-under-hard-pressure)
eli16-overview: multi-session-autonomy.eli16.md
---

# Multi-session autonomy

## Problem

instar runs exactly one autonomous job at a time. State lives in a single file,
`.instar/autonomous-state.local.md`; `setup-autonomous.sh` writes it and
`autonomous-stop-hook.sh` reads it. Starting a second autonomous job overwrites the
first's state and silently destroys its enforcement. The topic-keyed identity fix
(v1.2.55) made an autonomous job identifiable by its **topic** and made the stop hook
resolve its own topic — so the only remaining cause of one-at-a-time is the single
shared state file.

## Goal

Multiple concurrent autonomous jobs, one per topic, fully isolated — start, run, restart,
complete independently with no collisions — plus the safety rails that N long-running
jobs require.

## Design

### Per-topic state files

```
.instar/autonomous/<topicId>.local.md      # exactly one job per topic
```

- `setup-autonomous.sh` writes to the per-topic path derived from `--report-topic`.
- `autonomous-stop-hook.sh` resolves its own topic (already implemented), then reads
  `.instar/autonomous/<myTopic>.local.md`. Active file → enforce that job; absent → allow
  exit. All per-job logic (duration, completion promise, recovery note, liveness backstop)
  is already keyed off a single state file's contents, so it carries over unchanged per
  topic. Different topics are different "addresses" with their own files → collisions are
  structurally impossible (the original brief's "Option B").

### Back-compat (a legacy single-file job may be in flight)

1. Hook resolves topic → looks for `.instar/autonomous/<topic>.local.md` first.
2. If absent, fall back to the legacy `.instar/autonomous-state.local.md` (preserves
   today's behavior for an in-flight job that started before this change).
3. Idempotent migration: a legacy file carrying a `report_topic` is moved to the per-topic
   path on first touch; never disrupts a running job mid-flight.

### Concurrency cap (decision: 5)

`autonomy.maxConcurrent` in `.instar/config.json`, **default 5**, configurable. Starting a
job when `maxConcurrent` active per-topic files already exist is refused with a clear
message naming the running topics. Enforced at start (in the autonomy-start path), not by
prompt discipline.

### Quota awareness (decision: refuse-new; pause-running only under hard pressure)

- At autonomous-start: consult `GET /autonomous/can-start` which checks
  `QuotaTracker.shouldSpawnSession(priority)`. If not allowed → **refuse the new start**
  (do not preempt running jobs for a new one). This is the primary protection and is
  wired structurally (`setup-autonomous.sh` refuses on a deny; local cap backstop if the
  server is unreachable).
- **Pause mechanism**: `paused: true` on a per-topic file makes its hook allow exit until
  resumed; `pauseAutonomousTopic()` exposes it. This lets a running job be shed under
  pressure (by an operator, the API, or a future pressure-monitor) without losing its state.

v1 quota behavior is **refuse-new + the pause mechanism**. Refuse-new is the structural
primary guard: it caps overspend at admission, and multi-session-with-refuse-new is strictly
tighter than the prior single-session behavior (which had no quota gate on the running job at
all). An automatic pressure-monitor that pauses running jobs without operator action is an
optional intelligence on top of this mechanism, evaluated on its own merits — it is not part
of the v1 contract, which is fully satisfied by refuse-new + pausability.

### Stop semantics (decision: per-topic stop ships in v1)

- **Global stop-all** (non-negotiable): "stop everything" / emergency stop removes **every**
  `.instar/autonomous/*.local.md` (and the legacy file) and writes the existing
  `.instar/autonomous-emergency-stop` flag. Wired through the existing stop path
  (`src/server/stopGate.ts` / MessageSentinel) so the global semantics are unchanged for the
  user, just fan out across all jobs.
- **Per-topic stop** (v1): "stop the autonomous job on topic X" removes only that topic's
  file. Exposed via the API + conversationally.

### Visibility & management

- `GET /autonomous/sessions` (net-new route) → all active jobs: topic, goal, iteration,
  startedAt, time remaining, paused flag, last recovery. (+ `POST /autonomous/sessions/:topic/stop`
  for per-topic stop, `POST /autonomous/stop-all`.)
- Conversational: "what autonomous jobs are running?", "stop the one on topic X", "stop
  everything"; surfaced in the dashboard session view.

## Standards conformance (reviewed)

- **Structure > Willpower:** the cap, quota gate, stop-all fan-out, and per-topic
  enforcement are all code/hook-level, not prompt reminders.
- **Signal vs authority:** the hook remains a consumer of the topic registry + per-topic
  state; the only new blocking authority is the cap/quota gate at start, which has full
  context (it reads config + QuotaTracker), not a brittle low-context filter.
- **Near-silent notifications:** only the pause-under-pressure heads-up and refusal messages
  are user-facing; routine starts/stops are silent (visible via the list API on pull).
- **No manual work:** per-topic files, migration, and stop-all are automatic; the user never
  hand-edits state.
- **Migration parity:** updated hook (always-overwrite via the migration we shipped), updated
  `setup-autonomous.sh`, new config default `autonomy.maxConcurrent` (existence-checked in
  `migrateConfig`), CLAUDE.md template additions — all reach existing agents.
- **Agent awareness:** CLAUDE.md template gains the multi-session capability + list/stop verbs.

## Test plan (all three tiers)

- **Unit:** two+ per-topic files enforced independently; topic A's hook never reads/writes
  topic B's file; legacy fallback; legacy→per-topic migration idempotent; cap refusal at the
  boundary; quota refusal; stop-all clears every file; per-topic stop clears exactly one;
  pause sets the flag and the paused job's hook allows exit.
- **Integration:** `GET /autonomous/sessions` returns all active jobs; per-topic stop and
  stop-all via the API; cap/quota refusal returns the right status.
- **E2E:** two concurrent autonomous jobs run; one restarts (survives, isolated, one recovery
  note); the other completes (its file removed, the first untouched); stop-all halts both;
  a third start beyond the cap is refused.

## Acceptance criteria

1. N (≤5) topics each run an isolated autonomous job; no cross-topic interference.
2. Starting beyond the cap, or under quota refusal, is rejected with a clear message.
3. Stop-all halts every job; per-topic stop halts exactly one.
4. A legacy in-flight single-file job keeps working and migrates cleanly.
5. List API + conversational visibility report all active jobs.
6. Existing agents receive it (migration parity); all three test tiers green; full suite
   green at push.

## Phasing

- **Phase 1:** per-topic state files + hook resolution + legacy fallback + migration.
- **Phase 2:** concurrency cap + quota integration + stop-all + per-topic stop.
- **Phase 3:** list/stop API + conversational + dashboard + CLAUDE.md awareness.

Each phase ships complete with its own tests — no half-wired capability between phases.
