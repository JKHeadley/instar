# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Managed worktree creation allows up to five minutes for Git to check out the source files. The general 30-second deadline could interrupt healthy large checkouts, especially after reboot. Only worktree add gets the longer deadline; other Git commands preserve their defaults. Existing safety checks and creation locking remain.

## What to Tell Your User

Creating an isolated copy of the project now has more time to finish when the computer is busy.

## Summary of New Capabilities

No new capability or setting. This repairs existing worktree creation.

## Evidence

The baseline failed both new/existing branch regression cases for the expected reason. The patched integration file passed all 15 cases with zero failures or skips. Complete coordinator verification remains required. The regression models a 45-second requirement at the executor boundary and delegates actual Git operations, rather than sleeping in a test.
