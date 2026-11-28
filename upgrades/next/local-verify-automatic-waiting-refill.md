# Upgrade Guide — vNEXT

## What Changed
The verification coordinator now automatically re-offers live durable waiting requests when ordinary queue places open. It preserves existing holds and complete-suite requirements, bounds each pass, and temporarily backs off unreadable requests without losing their age.

## Evidence
Unit regressions cover automatic refill, transient-read starvation, ownership loss, unhealthy main, held/stale requests and bounded overlapping ticks. HTTP and production-wiring lifecycle cases exercise current-head refresh and restart persistence. Actual normal-enforcing focused run passed 23 unit checks, nine HTTP integration checks and eight production-wiring lifecycle checks, with zero skipped cases and all three exits zero. Final build and normal dependency-hook preparation passed. Full exact-head verification remains required.

## What to Tell Your User
Finished changes waiting for a test slot can enter the verification queue automatically when space opens. Existing priorities and safety holds still apply, and the full checks are still required before a change can merge.

## Summary of New Capabilities
No new API or setting. The existing saved waiting requests are re-offered automatically by the verification coordinator.
