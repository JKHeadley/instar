# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Self-knowledge health now returns null cache, latency, and error metrics when no
search trace exists. A search with no cache operations also reports a null cache
hit rate, and machine diagnostics name the absence instead of formatting zero.

## What to Tell Your User

An unused or unreadable self-knowledge trace no longer looks like perfect
zero-millisecond, zero-error performance.

## Summary of New Capabilities

- Explicit unmeasured state for self-knowledge health metrics.
- Plain-language machine diagnostics for missing search samples.

## Evidence

- Tests cover both a missing trace and a real search with no cache operations.
- Restoring the zero fallbacks makes both regressions fail.
- Eleven focused tests and full repository lint pass.
