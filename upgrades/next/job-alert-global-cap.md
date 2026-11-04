# Scheduled jobs wait at the global session limit

## What Changed

The global session limit now returns a typed capacity refusal. Scheduled jobs wait in the existing priority queue without gaining a failure, and one scheduled job may use a guarded extra session place when conversations fill the ordinary allowance and memory is healthy. Old per-job failure reminders pause during the wait.

## Evidence

Regression tests first failed on the old global-limit behavior, then passed for typed waiting, a single guarded extra slot, simultaneous requests, high memory pressure, and conversations beyond the soft cap. The full repository verifier is required before merge.

## What to Tell Your User

Scheduled checks no longer report a failure merely because conversations have filled the Studio's ordinary session allowance. They wait and try again when there is room.

## Summary of New Capabilities

One scheduled job can run beyond the ordinary conversation allowance when memory is healthy, while the hard host limit and the subscription lane limit still protect the machine.
