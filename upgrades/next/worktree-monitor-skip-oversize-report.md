<!-- bump: patch -->
## What Changed

At boot, the worktree monitor no longer parses a saved report over 16 MB. Older versions could leave a report of hundreds of MB, and parsing one at boot ran the Studio server out of memory (2026-11-19). The first scan replaces the file.

## What to Tell Your User

Nothing to do. This removes a start-up crash on machines that still hold an old, oversized report.

## Summary of New Capabilities

- A boot-time size guard on the worktree monitor's saved report.

## Evidence

- `tests/unit/worktree-monitor.test.ts`: 37 of 37 pass, including 2 new cases.
