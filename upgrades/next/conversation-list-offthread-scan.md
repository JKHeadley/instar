# The server no longer freezes when the app opens its conversation list

<!-- bump: patch -->

## What Changed

The phone and Mac apps' conversation list used to make the agent's server re-read its whole Telegram message history once for every conversation it had not read since it started. On an agent with hundreds of conversations that froze the server for 20-30 seconds. The server now reads the history once, in small pieces, letting everything else run in between. It fills the same in-memory store it already had, and only after checking the file did not change underneath it. A chat opened before any list (for example from a notification right after a restart) does the same. Nothing new is stored, and the old read still runs whenever the new one cannot finish cleanly. One setting, `telegramHistoryScan.offMainThread: false`, switches the new read off without a restart.

## What to Tell Your User

- **Smoother app, fewer stalls**: "I fixed a slowdown where opening the conversation list in the app could freeze me for up to half a minute."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation list and first chat open without server stalls | Automatic |

## Evidence

- Unit: `tests/unit/telegram-offthread-history-scan.test.ts`.
- Integration: `tests/integration/conversation-list-offthread-scan.test.ts`.
- E2E: `tests/e2e/conversation-list-offthread-scan-alive.test.ts` (a cold list and a cold chat on a ~25 MB log with no synchronous read of the log; the longest stall is logged as a diagnostic). The switch-off path is asserted by the integration test.
