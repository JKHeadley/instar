# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The degraded-tmux guard now treats a missing CPU-core denominator as an
unavailable load measurement instead of zero load. Corroboration does not
advance until the load gate has a real value.

## What to Tell Your User

If the operating system cannot report a CPU count, Instar no longer interprets
that missing measurement as a perfectly idle host when deciding whether to
raise a degraded-tmux notice.

## Summary of New Capabilities

- Explicit unknown state for the degraded-tmux load gate.
- A shared conversion boundary that preserves a measured zero while rejecting
  an unavailable denominator.

## Evidence

- Tests cover zero measured load, missing core count, and a throwing provider.
- The production provider uses the tested conversion boundary.
- Restoring the zero-denominator fallback makes the load-gate tests fail.
