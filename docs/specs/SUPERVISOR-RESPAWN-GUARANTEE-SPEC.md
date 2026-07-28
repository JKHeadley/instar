---
title: "Supervisor respawn guarantee — a dead server always comes back"
slug: "supervisor-respawn-guarantee"
author: "echo"
date: 2026-06-14
eli16-overview: "SUPERVISOR-RESPAWN-GUARANTEE-SPEC.eli16.md"
status: "approved"
approved: true
approved-by: Justin
approved-via: 'Telegram topic 13481, 2026-06-14 16:04 PDT — "We really need to make instar completely robust and recoverable against session death this is absolutely nonnegotiable" + standing autonomous pre-approval ("You have my pre-approval for all decisions needed")'
review-convergence: tactical-hotfix-2026-06-14
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — server liveness recovery must be guaranteed by an unconditional structural check (does the process exist?), never gated behind a heuristic (sleep/wake inference) that can be wrong"
project: "lifeline-robustness"
---

# Spec — Supervisor respawn guarantee

> **One sentence:** when the server process is genuinely gone, the supervisor must
> respawn it within one health tick — no grace period, sleep/wake guess, or CPU-load
> condition is allowed to suppress respawning a process that does not exist.

## 1. Triggering incident (2026-06-14)

The echo server crashed at ~13:11 PDT (an uncaught exception while restarting the
Cloudflare tunnel during a sleep/wake on an iPhone hotspot, under heavy CPU load —
`[FATAL] Uncaught exception … This operation was aborted`, and a recurring sibling
`[FATAL] … Sent before connected` from the Slack socket). The server process died
and its tmux session (`echo-server`) vanished.

It stayed dead for ~2 hours. No layer brought it back until the operator messaged and
I manually `launchctl kickstart`-ed the lifeline. Three independent recovery nets were
all down at once:

1. **In-process crash handling** — a single uncaught exception in one subsystem (Slack
   socket / tunnel restart) crashes the *entire* server (`closing databases before crash`).
2. **The lifeline `ServerSupervisor`** — the in-process net meant to detect a dead
   server and respawn it — was trapped (root cause below) and never respawned.
3. **The fleet watchdog** (`~/.instar/instar-watchdog.sh`, 5-min `launchd` cadence) —
   the OS-level independent backstop — was exiting non-zero before completing its
   respawn pass.

This spec closes net **#2** (the direct cause of the 2-hour gap) as the primary,
load-bearing guarantee. Nets #1 and #3 are tracked as explicit follow-ups in §6 so
the loop stays open until they are closed (no silent partial fix — see the instar-dev
no-deferrals lesson). <!-- tracked: CMT-1540 -->

## 2. Root cause (net #2 — the ServerSupervisor trap)

`src/lifeline/ServerSupervisor.ts`, `startHealthChecks()` (the 10s health loop):

- Two paths reset the supervisor's failure state **and** `spawnedAt = now`:
  - the `SleepWakeDetector` `'wake'` handler (≈L977-986), and
  - the inline **gap-based** sleep/wake check (≈L997-1008): *any* inter-tick gap larger
    than `sleepWakeGapMs` is treated as a machine suspend.
- Resetting `spawnedAt = now` re-enters the **startup-grace branch** (≈L1015-1029),
  where health-check failures are deliberately **ignored** (`catch {}` / `return`) so a
  booting server isn't killed prematurely.

Under sustained CPU starvation the event loop is stalled for minutes at a time, so the
10s `setInterval` ticks arrive 300–980s apart. The inline gap check has **no
load-awareness** (unlike the `SleepWakeDetector`, which already suppresses a wake when
`loadRatio > 1.5`). So every stalled tick is misread as a fresh sleep/wake → `spawnedAt`
resets → the supervisor is pinned in grace mode → **every** failure is ignored —
including the unambiguous signal that the server tmux session no longer exists.

The grace-mode branch never calls `isServerSessionAlive()`; the missing-session →
`handleUnhealthy()` respawn path (≈L1091-1093 / L1115-1117) lives only in the
non-grace branch, which a trapped supervisor never reaches.

## 3. Design — the guarantee

**Invariant:** a grace period is a promise about a process that *exists and is booting*.
It must never apply to a process that *does not exist*. A missing tmux session is
unambiguous death and is not subject to sleep/wake or load interpretation.

### Fix A — Missing-session override (primary, load-bearing)
At the top of each health tick, **before** the startup-grace early-return, probe
`isServerSessionAlive()`. If the server session does **not** exist:
- skip grace entirely and call `handleUnhealthy()` (respawn) immediately, subject only
  to the existing circuit-breaker / restart-attempt accounting (so a genuine crash-loop
  still trips the breaker rather than hot-spinning);
- this path is reached on the very next 10s tick after a crash, regardless of any
  sleep/wake reset or grace window.

A booting server *does* have a live tmux session (the session is created at spawn, the
HTTP listener comes up later), so Fix A never fights a normal boot — it only fires when
the process is genuinely gone.

### Fix B — Load-aware gap detection (prevent the trap at its source)
Before the inline gap check (≈L997) treats a large gap as sleep/wake, consult system
load (`os.loadavg()[0] / cpuCount`, the same signal the `SleepWakeDetector` uses). If
load-per-core exceeds a starvation threshold (default `1.5`, config
`lifeline.supervisor.cpuStarvationLoadPerCore`), classify the gap as a **stalled event
loop**, not a suspend: do **not** reset `spawnedAt` (failure counters may still be reset
to avoid a stale cascade, but the grace window is not re-armed). Apply the same
load guard to the `SleepWakeDetector` `'wake'` reset of `spawnedAt`.

### Fix C — Absolute grace ceiling (belt-and-suspenders)
Track `firstSpawnedAt` (the wall-clock of the first spawn that has not yet reached a
healthy probe). Cap cumulative grace so repeated `spawnedAt` resets can never extend the
ignore-failures window beyond `startupGraceMs × 3` of real wall-clock from
`firstSpawnedAt`. Past the ceiling, failures are acted on normally even if `spawnedAt`
was just reset.

## 4. Signal vs authority

Per `docs/signal-vs-authority.md`: the supervisor legitimately holds **authority** (it
kills and respawns the server). The fix does not add brittle blocking logic — it makes
the existing authority *more* reliable by grounding the respawn decision in an
**objective, non-heuristic** fact (does the tmux session exist?) instead of a fragile
inference (did the machine sleep?). The heuristic (sleep/wake) is demoted to where it is
safe (leniency for an *existing* slow process), and can never suppress recovery of a
*missing* process. This is the correct direction: replace willpower/heuristic with
structure.

## 5. Tests (all three tiers per the Testing Integrity Standard)

**Unit (`tests/unit/server-supervisor-respawn-guarantee.test.ts`):**
- Missing session during startup grace → `handleUnhealthy()`/spawn fires on next tick
  (the exact 2026-06-14 trap; regression lock).
- Missing session during a (false) wake-transition window → respawn still fires.
- High load-per-core + large inter-tick gap → `spawnedAt` is **not** reset (grace not
  re-armed); low load + large gap → still treated as sleep/wake (real-suspend behavior
  preserved).
- Absolute grace ceiling: repeated resets cannot keep a dead-but-session-present server
  ignored past the ceiling.
- An *alive, booting* session (session present, health not yet 200) is still given the
  full normal grace — Fix A does not regress boot tolerance.

**Wiring-integrity:** assert the health loop calls `isServerSessionAlive()` on every
tick (not only in the non-grace branch).

## 6. Tracked follow-ups (Close the Loop — do NOT silently drop) <!-- tracked: CMT-1540 -->

- **FU-1 (net #1): subsystem crash containment.** Prevent the specific uncaught throws
  that crash the whole server — guard the Slack socket send against `Sent before
  connected`, and the tunnel-restart abort path. <!-- tracked: CMT-1540 -->
- **FU-2 (net #3): fleet watchdog reliability.** CONFIRMED LIVE ROOT CAUSE
  (2026-06-14 16:20 PDT, echo laptop): the `ai.instar.watchdog` launchd job was loaded
  from a **reaped temp staging plist** — `launchctl print` showed
  `path = /private/var/folders/.../T/iwm-mig-ao4gPw/Library/LaunchAgents/ai.instar.watchdog.plist`
  with `stdout/stderr path` into that same vanished temp dir. macOS reaps `/var/folders`
  temp dirs, so every launchd run then exited **127** (redirect target gone), logs going
  into the void, even while the script (canonical program path) still limped through its
  pass. The watchdog **never self-heals its own job** (it explicitly skips
  `ai.instar.watchdog` at L314/L613), so nothing corrected it. Fixed live via `bootout` +
  `bootstrap` from the canonical `~/Library/LaunchAgents/ai.instar.watchdog.plist`
  (last exit code → 0, verified actively recovering the fleet). DURABLE FIX NEEDED:
  (a) the install/migration path must bootstrap the watchdog plist from its **canonical**
  location, never a temp staging dir that gets reaped; and (b) add a self-job integrity
  check so an orphaned-path watchdog job is detected and reloaded from canonical (the one
  job the watchdog currently can't heal is its own). Also audit
  `src/templates/scripts/instar-watchdog.sh` for bash-3.2 `set -u` empty-array
  `"${arr[@]}"` safety (an older deployed copy hit that at L465, since fixed) and ensure a
  confirmed-dead *server* (not just lifeline) is respawned. <!-- tracked: CMT-1541 -->

Both follow-ups are real and must be closed; this spec ships net #2 first because it is <!-- tracked: CMT-1540 -->
the proven cause of the observed 2-hour outage and a single rock-solid net delivers the
operator's non-negotiable guarantee on its own.
