# Side-Effects Review — Supervisor CPU-starvation restart guard

**Version / slug:** `supervisor-cpu-starvation-restart-guard`
**Date:** `2026-05-29`
**Author:** `echo`
**Spec:** `docs/specs/supervisor-cpu-starvation-restart-guard.md` (+ `.eli16.md`)
**Convergence:** `docs/specs/reports/supervisor-cpu-starvation-restart-guard-convergence.md` (fast-tracked — urgent fleet bug; see report)
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check")

## Summary of the change

Fixes the overload-driven server restart loop that drops user messages (Justin,
topic 15160: "Session restarting, message never lands"). Under CPU starvation
the live server can't answer `/health`, so `ServerSupervisor` restarted it every
~60s — but a fresh server is starved too, so it just dropped the in-flight
message and looped. Verified in `logs/server.log`: 6 server restarts in ~35min
during a load spike (load ratio ~2× cores).

The guard makes the supervisor load-aware: while the box is CPU-starved
(`loadavg[0]/cpuCount > 1.5`, the same signal SleepWakeDetector uses), an
alive-but-unresponsive server's restart is DEFERRED (up to a 5-minute hard cap)
instead of bounced.

## Files touched

- `src/core/cpuStarvation.ts` (**new**) — shared `cpuLoadRatio` / `isCpuStarved`
  + `DEFAULT_MAX_LOAD_RATIO`.
- `src/lifeline/ServerSupervisor.ts` — extracted the two identical
  health-failure branches into `evaluateUnhealthyServer()`; added
  `deferRestartForCpuStarvation()`, `maxLoadRatio`, `starvationRestartThreshold`,
  and an injectable `loadRatioProvider`.
- `tests/unit/cpu-starvation.test.ts` (new), `tests/unit/supervisor-cpu-starvation-defer.test.ts` (new).

## Decision-point inventory

- **Restart vs defer (alive + unresponsive)** — *modify, additive*. Was: restart
  at `processAliveThreshold` (6 failures). Now: if CPU-starved and below the hard
  cap, defer; else unchanged. A pure presence check on system load, not a
  judgment. All branches covered by tests driving the real method.
- **Branch extraction** — *refactor, behavior-preserving*. The two duplicated
  failure paths (unhealthy `/health`, thrown check) now call one
  `evaluateUnhealthyServer()`. The non-starved/dead/below-threshold behavior is
  byte-for-byte the same; verified by the existing `supervisor-health-check`
  test still passing + new real-method tests.
- **Load read** — *read-only*. `os.loadavg()` / `os.cpus().length` via the shared
  helper; returns 0 on error (fails toward "not starved" → restart, the safe
  legacy behavior). No new file, no write, no new external surface.

## Blast radius

- **No new authority, no new gate, no new API route, no external surface.** A
  defer behind the existing restart decision.
- **Strictly less aggressive.** Can only DEFER a restart it would otherwise do,
  only while genuinely CPU-starved, only up to a 5-min hard cap. Dead process →
  immediate restart unchanged; not-starved → restart at 6 unchanged. Cannot
  strand a hung server (hard cap) and the defer self-clears on the next healthy
  tick.
- **No agent-installed files changed** — pure `src/` (lifeline + a helper). No
  `PostUpdateMigrator` entry required; the lifeline picks it up on its next
  restart via the existing version-skew/drift coordination.

## Pre-existing-bug note

The two health-failure branches were identical copy-paste — a latent drift risk
(a fix to one could miss the other). Extracting them into one method removes that
hazard as a side benefit.

## Phase 5 trigger check (second-pass reviewer)

Second pass **not required**: no new authority, no new destructive operation (the
only behavioral delta REMOVES a restart while starved), no external surface, no
migration. Additive, read-only load signal behind an existing restart primitive,
with real-method unit coverage + a wiring guard.

## Verification

- `tests/unit/cpu-starvation.test.ts` — pure helper (ratio + threshold).
- `tests/unit/supervisor-cpu-starvation-defer.test.ts` — REAL
  `evaluateUnhealthyServer()`: defer-while-starved, restart-when-not,
  force-restart-past-cap, dead→immediate, below-threshold→wait,
  defer-not-permanent + wiring guard. 19 pass with the existing
  `supervisor-health-check` suite.
- `tsc --noEmit` clean.
