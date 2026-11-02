<!-- bump: patch -->

## What Changed

The server supervisor and foreground restart watcher now defer ordinary planned restarts while a local full PR check is running. Once that check ends, the restart gets the next turn; the verifier pauses new checks while the request waits. Explicit forced restarts and the updater's maximum deferral limit still take effect. This prevents planned setting changes from discarding minutes of completed test work.

## What to Tell Your User

Planned maintenance will wait for an active PR check to finish, then restart before another check begins. This avoids throwing away completed test work while keeping forced restarts available.

## Summary of New Capabilities

- Planned server restarts coordinate with active local PR verification across the supervisor and foreground server modes.

## Evidence

Before this fix, planned setting-change restarts interrupted PR #2525 twice on 2026-11-01 and discarded 302,324 plus 480,567 milliseconds of active verification. The new unit, integration, and production startup lifecycle tests show the request remains pending while the child runs, then is consumed after completion. The full suite is required before release.
