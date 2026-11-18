# The worktree cleaner stops freezing the server

<!-- bump: patch -->

## What Changed

The cleaner that reports which old working copies of code could be removed did all its checking on the server's main thread. On a machine with a few hundred copies, that froze the server for about 45 seconds each time it checked: 15 minutes after every start, once a day, and whenever its status page was opened. The check now runs on a background thread, and its status page shows the last result and its age instead of redoing the work. Its verdicts are unchanged. A check stuck for 30 minutes is stopped and recorded as failed.

## What to Tell Your User

- **No more freezes from the worktree cleaner**: "A routine check that used to freeze me for up to a minute now runs in the background, so I stay responsive."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cleaner report from the last check | `GET /worktrees/agent-reaper` now carries `evaluatedAt`, `source` and `passRunning` |
