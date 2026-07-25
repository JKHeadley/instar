# UX-first enforcement increment 3

## What Changed

The UX assertion tier now includes deterministic timing checks using an injected clock. The real messaging E2E covers both a response inside its declared bound and one that exceeds it.

## What to Tell Your User

Tests now verify not only what a user sees and whether failures are honest, but also whether the visible response arrives within its promised time.

## Summary of New Capabilities

- Reusable `Clock`, `RealClock`, and manually advanced `TestClock`.
- `assertTimely(events, boundMs, clock)` with no external dependencies.
- CI-visible within-bound and exceeded-bound messaging cases.
