# A server that has been healthy gets its full startup allowance after a restart

<!-- bump: patch -->

## What Changed

The lifeline's server supervisor gives a respawned server a startup allowance (`startupGraceMs`, 10 minutes) with an absolute ceiling of 3 × that allowance per unhealthy episode, measured from `firstSpawnedAt`. A healthy tick cleared `firstSpawnedAt`, but the next tick re-anchored it to the running server's long-past `spawnedAt`, so a server healthy for more than 30 minutes met its first outage with the ceiling already exceeded. Because a respawn resets `spawnedAt` but not `firstSpawnedAt`, every respawn in that outage got only the ~60 s alive-but-unresponsive allowance, and boots slower than that were killed repeatedly. The anchor is now set only while the current spawn has not yet answered healthy (`lastHealthy < spawnedAt`). A server healthy for any length of time gets the full allowance on its next respawn; within one unhealthy episode the anchor stays at the first respawn, so the ceiling still ends a hopeless stretch. Missing-session immediate respawn, the circuit breaker, restart backoff, sleep/wake and CPU-starvation handling are unchanged.

## What to Tell Your User

- **Slow restarts are no longer cut short**: "When my server had been running fine for a while and then needed a restart, I was only giving the restarted copy about a minute to start up, so a slow start got killed and retried over and over. It now gets its normal ten minutes, and I still give up on a copy that never starts."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Full startup allowance on the first restart after a healthy run | Automatic in the lifeline supervisor |

## Evidence

Echo Laptop, 2026-11-21 03:00 PST (feedback fb-6b354765-24a): boots needing 75–150 s were killed five times in one outage. `tests/unit/supervisor-grace-ceiling-reanchor.test.ts` drives the real `runHealthTick()`, `handleUnhealthy()` and `spawnServer()` over a simulated clock. Before the fix all 4 tests failed: after 40 healthy minutes a 150 s boot was respawned 5 times about 65 s apart, and the anchor pointed at the original spawn. After the fix all 4 pass: one respawn, the boot completes, and a never-healthy episode is still clipped by the ceiling between 30 and 32 minutes after its first respawn. The related supervisor test files (9 files, 79 tests) pass.
