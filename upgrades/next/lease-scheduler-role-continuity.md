# Lease scheduler follows the holder

## What Changed

A machine that gains the lease now starts scheduled jobs through a bounded planned restart. A machine that loses the lease pauses jobs immediately, including when a preferred-machine hint is configured.

## What to Tell Your User

Scheduled jobs now follow the machine holding the lease. If a standby takes over, it starts its scheduler after a planned restart; the former holder stops admitting jobs.

## Summary of New Capabilities

- The lease holder starts scheduled jobs even when a preferred-machine hint is configured.
- A demoted machine pauses jobs before it can launch new work.
