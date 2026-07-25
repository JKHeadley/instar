# Liveness-aware SpawnAdmission checkpoint

## What Changed

The dry-run router-queued-suppress checkpoint now records a would-block only when a live starting/running session already exists for the same conversation key.

## What to Tell Your User

Dead-session recovery is no longer counted as a duplicate. A real duplicate with an already-live session remains visible for the next soak review.

## Summary of New Capabilities

- Session-key liveness check at spawn evaluation time.
- Regression tests for live duplicate and completed/dead respawn cases.
