## What Changed

Hardened the in-process **server supervisor** (`src/lifeline/ServerSupervisor.ts`) so a genuinely-dead server is always respawned, even under sustained CPU starvation. This closes a real ~2h outage class (2026-06-14): on a heavily-loaded box the supervisor's 10s health loop stalls for minutes, and it misread every large inter-tick gap as a machine sleep/wake — resetting `spawnedAt = now`, which re-armed the startup-grace window where health failures (including the unambiguous signal that the server's tmux session no longer exists) are deliberately ignored. The server stayed dead until a human messaged.

Three layered fixes, all in the health-check tick:

- **Fix A (load-bearing) — missing-session override.** Before honoring any startup-grace early-return, the tick now probes `isServerSessionAlive()`. A missing server tmux session is unambiguous death, not a boot, and is respawned on the very next tick regardless of any `spawnedAt` reset — routed through the existing `handleUnhealthy()` so the circuit breaker still bounds a genuine crash-loop. A normally-booting server has a live tmux session (created synchronously at spawn; HTTP binds later), so this never fights a real boot.
- **Fix B — load-aware gap detection.** A large inter-tick gap is only treated as sleep/wake when the box is NOT CPU-starved. Under starvation (`loadRatio > 1.5`, the same signal the CPU-starvation defer already uses) the gap is classified as a stalled event loop: failure counters reset, but the startup-grace window is NOT re-armed. The same guard is applied to the `SleepWakeDetector` wake handler. A real low-load suspend still re-arms grace exactly as before.
- **Fix C — absolute grace ceiling.** A new `firstSpawnedAt` anchor (never reset by sleep/wake handling) caps cumulative startup grace at `startupGraceMs × 3`. A server whose session is alive but has never answered `/health` past the ceiling is hung, not booting, and its failures are acted on normally.

The inline `setInterval` callback was extracted verbatim into `runHealthTick()` so a single tick is unit-testable and a wiring-integrity test can assert the loop probes session liveness on every tick.

audience: agent-only
maturity: stable

Net #1 (a subsystem uncaught exception crashing the whole process) and net #3 (the launchd fleet watchdog) are tracked follow-ups in the spec §6. Net #3's live root cause was additionally found and fixed in production this session (the `ai.instar.watchdog` launchd job was loaded from a reaped temp-dir plist → exit 127); the durable source fix is tracked in FU-2. <!-- tracked: CMT-1540 -->

## What to Tell Your User

Nothing to announce proactively. If asked about server reliability: when my server process genuinely dies, the supervisor now respawns it within one health tick (~10s) instead of being fooled by CPU load into thinking the machine went to sleep and waiting indefinitely. The recovery decision is now grounded in an objective fact — does the server process actually exist? — rather than a sleep/wake guess that could be wrong on a busy machine. Normal slow boots are still given the full startup grace, so this never restarts a server mid-boot.

## Summary of New Capabilities

No new user-facing capability — a reliability hardening of the existing crash-recovery supervisor.

| Change | Effect |
|--------|--------|
| Missing-session override (Fix A) | A dead server tmux session is respawned on the next ~10s tick, even during startup grace |
| Load-aware gap detection (Fix B) | A CPU-starvation event-loop stall is no longer misread as sleep/wake; grace is not falsely re-armed |
| Absolute grace ceiling (Fix C) | Repeated `spawnedAt` resets can no longer suppress recovery beyond 3× the grace window |

## Evidence

Reliability fix; pinned by `tests/unit/server-supervisor-respawn-guarantee.test.ts` (10) driving the real extracted `runHealthTick()` and `SleepWakeDetector` wake handler: missing-session-during-grace → respawn (the exact 2026-06-14 trap), missing-session-during-false-wake → respawn, starved-gap → `spawnedAt` not reset, low-load-gap → re-armed, grace-ceiling broken → failures acted on, in-grace booting server still protected (Fix A no boot regression), `firstSpawnedAt` cleared on healthy, and a wiring-integrity assertion that the tick probes `isServerSessionAlive()` every tick. The full existing supervisor/lifeline suite (63 tests across 8 files) still passes. `npx tsc --noEmit` clean.
