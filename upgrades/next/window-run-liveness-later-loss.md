## What Changed

- A later loss of an autonomous run's liveness check now gets its own 15-minute at-risk window after an earlier recovery returned the run to active. The old recovery attempt remains spent; it never refreshes the executor twice.
- A run that never recovers from the first loss still fails on the original deadline.

## What to Tell Your User

A brief interruption after a previous recovered interruption will no longer stop an otherwise healthy autonomous run immediately. The run still pauses active work while any liveness check is red and fails if that interruption persists for 15 minutes.

## Evidence

- Unit tests cover successful and busy recovery, a later loss, healing, the 15-minute ceiling, and the same-millisecond boundary.
- Authenticated HTTP integration and production-boot E2E tests cover the route and full server path.

## Summary of New Capabilities

- Autonomous run liveness tracks each later interruption's observation deadline correctly while keeping one recovery actuation per run.
