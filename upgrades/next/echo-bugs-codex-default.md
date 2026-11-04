<!-- bump: patch -->

## What Changed

Telegram issues-group topics now default to Codex with `gpt-6.1-sol`. The optional `topicProfiles.groupDefaults.issues` config can override that group default. A topic's verified operator pin still wins. New Codex `gpt-6.1-sol` model IDs are recognized; a machine with a Codex CLI older than 0.166.0 uses `gpt-6-sol` with a plain note instead of starting a dead session. A framework-aware resume read keeps an old Claude session ID out of a new Codex launch.

## What to Tell Your User

New Echo Bugs topics start and restart on Codex by default. A machine that still has an older Codex version will use GPT-6 Sol and say so.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Issues group default | No configuration needed. An optional `topicProfiles.groupDefaults.issues` entry overrides the default. |

## Evidence

Focused unit tests failed before the fix and passed afterward. Topic resume lifecycle tests passed. Codex CLI 0.166.0 answered the earlier reported subscription probe; this worktree's sandbox prevented repeating the live probe. Live new-topic restart and footer evidence is still required at deployment.
