# Feedback work waits at its actual session limit

## What Changed

The feedback executor's early capacity check now uses the same limits as its actual confined canary and build spawns. It treats the final rerouted slot and the global overflow slot as reserved for scheduler-proven jobs. A full lane defers the feedback attempt before it claims an item, creates a workspace, or spends a start.

## What to Tell Your User

When background session capacity is full, feedback work waits cleanly for room instead of starting preparation and then failing at its safety check.

## Evidence

The production session manager's focused tests passed 65/65, covering the boundary where one rerouted slot remains reserved, the global session limit, actual refusal of a feedback canary, and continued admission of a scheduler-proven job. Build passed. Full unit, integration, end-to-end, and live post-deployment checks remain pending.
