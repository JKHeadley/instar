# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Self-knowledge traversal cache statistics now return a null hit rate before any
cache lookup has occurred. A degraded search that cannot load a tree also
returns a null cache hit rate, while a real first miss remains numeric zero.

## What to Tell Your User

A fresh or unavailable self-knowledge tree no longer looks like it measured a
zero-percent cache hit rate.

## Summary of New Capabilities

- Explicit unmeasured state for traversal cache statistics.
- Measured zero remains distinct for a real cache miss.

## Evidence

- Tests pin empty, first-miss, and mixed hit/miss states.
- Restoring both zero fallbacks makes two empty-state regressions fail.
- Twenty-seven focused tests and full repository lint pass.
