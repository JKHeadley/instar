# Worktree checks no longer pile up on busy machines

<!-- bump: patch -->

## What Changed

The worktree checker in the agent server (every 5 minutes, and after each session ends) now runs one scan at a time. If a scan is still running when the next one is due, the new request waits for it and shares its result instead of starting a second scan. On agent homes with hundreds of worktrees, scans could take longer than 5 minutes on a busy machine and overlap three at a time, each starting a burst of git processes; that load is gone. Reports and alerts are unchanged.

## What to Tell Your User

- **Less background load**: "On machines with a lot of work in progress, the agent's routine check of its working copies no longer runs several times over at once, so the machine stays more responsive."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Worktree checks never overlap | Automatic |

## Evidence

Tests: `tests/unit/worktree-monitor.test.ts` adds overlapping callers sharing one report, a fresh scan after the shared one settles, and a failed scan not blocking the next; 32 passed. Measured on the Mac Studio (345 worktrees, load 40+): about three overlapping scans per server before the change.
