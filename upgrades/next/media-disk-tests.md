# Upgrade Guide — media-disk-tests

## What Changed

`AppConversationService` takes an optional `mediaDiskSpace`, handed to the media store's existing free-space reader. Three test files use it, so they no longer read the real disk. Nothing changes in production: without the option the store reads the disk as before.

## What to Tell Your User

Nothing changes for you. This keeps the agent's own tests from failing when the computer running them is nearly out of disk space.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| None for users | Internal test setting only |

## Evidence

With the real reader forced to report a full disk, all 89 tests in the three files pass.
