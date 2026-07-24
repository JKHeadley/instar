# TIME_CLAIM subject binding

## What Changed

TIME_CLAIM now verifies only durations that are actually about the active session clock. Durations describing test windows, latency, task ETAs, queues, timeouts, outages, and recovery no longer cause false advisories.

## What to Tell Your User

Progress messages can describe ordinary durations without being mistaken for claims about how long the session has been running. Real elapsed, remaining, and percentage session-clock claims are still checked.

## Summary of New Capabilities

- Binds an anchored duration to its local subject before clock comparison.
- Preserves explicit and unqualified session-clock claim verification.
- Adds paired positive and negative boundaries for quantitative claim classifiers.

## Evidence

The focused TIME_CLAIM unit, route, and production-init E2E suite passes 71 tests. TypeScript passes after refreshing the current lockfile dependencies.
