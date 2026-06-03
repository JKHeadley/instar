# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

The `SessionReaper` gains a host-load-gated tightening of its `active-process`
keep-guard, behind a new dark-by-default flag `cpuAwareActiveProcessKeep`.

**The problem.** The reaper keeps a session whenever any non-baseline child
process *exists* (`hasActiveProcesses`). That existence check can't tell a
*working* child from a *wedged/idle* one — a hung MCP server or a stuck
`codex exec --json` job keeps a live PID while burning ~no CPU. So an otherwise
idle, reapable session is held un-reapable forever, and under host load those
zombie-child sessions are exactly what inflates CPU/memory pressure and starves
new spawns.

**The fix.** When `cpuAwareActiveProcessKeep` is on *and* the box is under CPU
pressure, the `active-process` existence-veto additionally requires *positive CPU
progress*: the reaper samples the session's accumulated descendant CPU-seconds
across ticks, and if the delta is below an idle floor (`cpuActiveMinRatePerSec`,
default 0.02 = 2% of one core), the existence-veto is relaxed. It does **not**
kill on that alone — it *falls through* to the reaper's existing stateful checks
(transcript-growth + positive-idle), all of which must still clear, plus the
hysteresis + two-phase + per-hour budget, before anything is reaped.

**Conservative by construction:**
- A strict no-op at `normal` pressure (zero behavior change off-load).
- A no-op when CPU can't be sampled, on the first sighting (no delta yet), or if
  accumulated CPU went backwards (pid reuse) — all resolve to KEEP.
- It tightens **only** the reaper's own decision. The shared `ReapGuard` /
  `ReapAuthority` path (the veto that protects sessions from *other* killers,
  e.g. `terminateSession`) is left completely untouched — zero blast radius
  there.
- Every time it relaxes the veto it writes a `cpu-keep-tightened` row to the
  decision audit (`logs/reaper-audit.jsonl`) — a behavior change to a kill path
  is never silent.

Ships dark fleet-wide and live on development agents (the `developmentAgent`
gate), so it's dogfooded on a real loaded box before any wider rollout.

## What to Tell Your User

Nothing — `cpuAwareActiveProcessKeep` is **dark by default** (off everywhere
except development agents). It changes no user-visible behavior on a normal
install. If surfaced at all, surface it as **⚗️ Experimental**: it refines the
reaper's idle-detection under load and is still being validated on dev agents.

## Summary of New Capabilities

- `monitoring.sessionReaper.cpuAwareActiveProcessKeep` (boolean, default false;
  `developmentAgent` agents default true) — under CPU pressure, require positive
  descendant-CPU progress before an existing-but-idle child process keeps a
  session un-reapable.
- `monitoring.sessionReaper.cpuActiveMinRatePerSec` (number, default 0.02) — the
  CPU-seconds-per-wall-second idle floor below which descendant CPU counts as
  "flat".
- A `cpu-keep-tightened` decision-audit event records each veto-relaxation.

## Evidence

- Root cause grounded at `ReapGuard.ts:139` (`hasActiveProcesses` is existence,
  not CPU) — the same gap the #706 `descendantCpuSeconds` helper was built to
  expose for the StaleSessionBackstop; this reuses it for the reaper.
- Tests: `tests/unit/session-reaper-cpu-aware-keep.test.ts` (12 tests, both sides
  of every boundary — veto relaxed only when CPU-flat under pressure + still
  protected by positive-idle / transcript-growth; never relaxed off-pressure,
  flag-off, dep-absent, first-sample, or CPU-rising) + a wiring-integrity
  assertion in `session-reaper-wiring.test.ts` (the `descendantCpuSeconds` dep
  and the `developmentAgent` gate are actually wired, not dead). The 43 existing
  reaper tests stay green (no behavior change off the new path).
