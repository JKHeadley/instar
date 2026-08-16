# Next Upgrade Guide

## What Changed

- **Duplicate topic prevention**: `findOrCreateForumTopic()` searches existing topic registry by name before creating new topics. Eliminates duplicate Telegram topics when sessions restart or jobs re-run. Applied to both `TelegramAdapter` (agent topics) and `JobScheduler` (job notification topics).
- **Test updates**: JobScheduler Telegram test updated to reflect `findOrCreateForumTopic` method signature.

## What to Tell Your User

Telegram topic duplication is now prevented at the infrastructure level. When a session restarts or a job re-runs, Instar will reconnect to the existing topic instead of creating a new one. No configuration changes needed.

## Summary of New Capabilities

- `TelegramAdapter.findOrCreateForumTopic(name, iconColor?)` — searches topic registry by name (case-insensitive) before creating. Returns `{ topicId, name, reused: boolean }`.
- `JobScheduler` and `server.ts /new` command both use `findOrCreateForumTopic` to prevent duplicates.
