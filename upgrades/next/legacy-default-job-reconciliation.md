# Legacy default jobs update safely

## What Changed

Updates now add missing shipped legacy jobs before migration. Git-sync stays disabled unless an operator explicitly enables it, even when the project has a Git remote.

## What to Tell Your User

Updates can restore missing built-in scheduled jobs without replacing local edits. Git-sync stays off unless you explicitly enable it.

## Summary of New Capabilities

- Missing shipped legacy jobs are added during update.
- Existing custom jobs and disabled settings remain intact.
- A Git remote alone cannot enable git-sync.
