# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Red-team boundary maps now return `derivationRatio: null` when no probe produced
a refusal. A measured zero remains zero when refusals exist but none are
grounded.

## What to Tell Your User

A scenario run with no refusal denominator no longer reports a zero-percent
grounded-refusal ratio.

## Summary of New Capabilities

- Explicit unmeasured state for refusal derivation coverage.
- Separate test coverage for absent and measured-zero denominators.

## Evidence

- Twenty-seven scenario-pack tests pass.
- Full repository lint and TypeScript checks pass.
- Restoring the old zero fallback makes the no-refusal test fail.
