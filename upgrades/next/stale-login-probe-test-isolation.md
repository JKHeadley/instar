# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Isolate stale-login integration and lifecycle stand-in probes from the operator host spawn semaphore. Retain real admission and recovery behavior, assert fixture-local holders paths, and cover saturated admission with no persisted child reservation. Runtime code is unchanged.

## What to Tell Your User

The checks for recovering an expired sign-in now use their own test state, so other work on the computer cannot change the result. This improves release verification; sign-in and recovery behavior in the app is unchanged.

## Summary of New Capabilities

No new capability or setting. Existing sign-in recovery checks are isolated from unrelated activity on the test computer.

## Evidence

Controlled capacity saturation reproduced the two refreshed-in-place versus swapped assertions. Targeted 34 unit, 4 integration and 4 lifecycle tests pass after fixture isolation. Independent read-only review concurs. Complete verification remains throughput-owned; no live-install result claimed.
