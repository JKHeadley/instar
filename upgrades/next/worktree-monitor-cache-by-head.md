<!-- bump: patch -->
## What Changed

The worktree monitor reuses each worktree's unmerged-work answer while neither its head nor the default branch has moved, and caches commit times. A quiet 5-minute scan now starts about 3 git processes instead of over 850 on a machine with about 430 worktrees.

## What to Tell Your User

Nothing to do. The background worktree check now uses far less of the machine.

## Summary of New Capabilities

- Per-commit caching in the worktree monitor's scan.

## Evidence

- `tests/unit/worktree-monitor.test.ts`: 39 of 39 pass, including a repeat scan with 0 per-worktree git calls and a recompute after the default branch moves.
