# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The per-decision-point quality view now returns `null` for outcomes-known,
unknown-grade, and self-report ratios when their respective denominators are
zero. The response continues to publish every denominator and its
`insufficientEvidence` flag.

## What to Tell Your User

An empty decision-quality point no longer looks like it measured perfect
outcome coverage, zero unknown grades, or zero self-reported evidence.

## Summary of New Capabilities

- Explicit unmeasured states for three per-point decision-quality ratios.
- Positive-denominator zero values remain measurable and unchanged.

## Evidence

- The HTTP integration test exercises a real wired point with an empty ledger.
- Tests separately preserve measured zero on a populated point.
- Restoring all three zero fallbacks makes the empty-row assertions fail.
