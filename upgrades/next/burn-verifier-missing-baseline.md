# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Post-throttle verification now reports a missing or zero pre-throttle rate as
inconclusive. It returns nullable ratio and success fields instead of treating
an empty denominator as a perfect reduction.

## What to Tell Your User

Instar no longer says a slowdown was successful when it has no measured
before-rate to compare with the current sample.

## Summary of New Capabilities

- Explicit insufficient-evidence state for post-throttle verification.

## Evidence

- The regression enters the zero-before-rate state and asserts a null ratio, a
  null success result, and an inconclusive follow-up message.
- Restoring the fabricated zero ratio makes the regression fail.
- Eleven focused tests and the full repository lint pass.
