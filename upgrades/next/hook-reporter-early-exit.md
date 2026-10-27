# hook-event-reporter exits as soon as the server answers

## What Changed

- The built-in `hook-event-reporter.js` (PostToolUse, every tool call) exits on the server's reply instead of always waiting a fixed 50 ms after sending; the 50 ms timer remains the upper bound. Both the `init` copy and the update copy (`PostUpdateMigrator`) change, so existing agents receive it on update.

## What to Tell Your User

Nothing to do. Each tool call finishes a few hundredths of a second sooner because a background script no longer waits longer than it needs to.

## Summary of New Capabilities

- None; efficiency fix.

## Evidence

Server reply time for `/hooks/events`: ~7 ms median locally; the old script waited 50 ms after sending by construction. `tests/unit/hook-installation.test.ts` runs the installed reporter against a real local server (event delivered with the expected path and payload, exit 0) and asserts the early exit; `tests/unit/hook-event-reporter-early-exit.test.ts` asserts the migrator copy. Related suites pass: 5 files, 50 tests.
