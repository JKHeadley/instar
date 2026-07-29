# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Threadline interaction statistics now return a null success rate for a trust
profile with no completed interactions. OpenClaw status names that state as
unknown instead of formatting it as a measured zero-percent success rate.

## What to Tell Your User

A newly created Threadline trust profile no longer looks like it has failed
every interaction before any interaction has occurred.

## Summary of New Capabilities

- Explicit unmeasured state for empty Threadline interaction history.
- Plain-language OpenClaw status for an unknown success rate.

## Evidence

- Unit, integration, and end-to-end Threadline suites pass.
- Restoring the zero fallback fails both the stats and formatted-status tests.
- Full repository lint and TypeScript checks pass.
