# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Job-history statistics now return null success and duration rates when no
completed run supplies a denominator. Category reports average only measured
job success rates instead of counting an unrun job as either 0% or 100%.

## What to Tell Your User

Jobs that have not run yet now show unknown performance rather than appearing
to have failed every run.

## Summary of New Capabilities

- Explicit unmeasured state for per-job and category success statistics.

## Evidence

- The regression asserts null success and duration for an unrun job.
- Aggregate tests prove an unrun job cannot dilute a measured 75% rate and an
  all-unrun category remains null.
- Restoring the zero fallback makes the regression fail.
- Fifty-three focused unit and lifecycle tests and full repository lint pass.
