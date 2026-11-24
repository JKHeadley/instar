# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Isolate stale-login integration and lifecycle stand-in probes from the operator host spawn semaphore. Retain real admission and recovery behavior, assert fixture-local holders paths, and cover saturated admission with no persisted child reservation. Runtime code is unchanged.

## Evidence

Controlled capacity saturation reproduced the two refreshed-in-place versus swapped assertions. Targeted 34 unit, 4 integration and 4 lifecycle tests pass after fixture isolation. Independent read-only review concurs. Complete verification remains throughput-owned; no live-install result claimed.
