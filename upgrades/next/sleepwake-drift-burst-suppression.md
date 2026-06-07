<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

The SleepWakeDetector mistook event-loop lag for sleep when the 1-min load average
momentarily dipped below its starvation threshold (which lags + fluctuates), firing
false wakes → a tunnel-restart storm every 1-3 min on a load-churning box. Adds a
load-independent consecutive-drift guard: a real sleep is one isolated drift, but
sustained starvation produces back-to-back drifts — so the 2nd+ consecutive SHORT drift
is suppressed regardless of the load reading. Genuine long sleeps (≥5min) are exempt.

New `driftBurstSuppressFloor` (default 2; 0 disables).

## What to Tell Your User

Nothing required — internal stability fix. If they saw the tunnel/dashboard flapping or
frequent restarts under load, this calms it.

## Summary of New Capabilities

- `SleepWakeDetectorConfig.driftBurstSuppressFloor` — suppress the Nth+ back-to-back
  drift as a CPU-starvation burst (load-independent). Default 2.

## Scope (honest)

Fix B of the operator's A+B pair (A = durable reaper candidacy). B reduces the restart
churn; A makes the reaper survive whatever churn remains. Targets the SHORT-drift storm;
genuine long sleeps still emit. Does not change the existing load-ratio or cooldown guards.

## Evidence

`tests/unit/sleep-wake-starvation-guard.test.ts`: 2nd consecutive short drift suppressed
under normal load + past cooldown; floor-0 contrast proves the guard; on-time tick resets;
long sleep exempt. 13/13 green. `tsc --noEmit` clean.
