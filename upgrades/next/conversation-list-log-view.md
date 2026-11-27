# The server no longer freezes when the app opens its conversation list

<!-- bump: patch -->

## What Changed

The phone and Mac apps' conversation list used to make the agent's server re-read its whole Telegram message history once for every closed conversation. On an agent with hundreds of conversations that froze the server for 20-30 seconds at a time. The server now keeps a memory copy of what that read returns, built once in the background and kept current, and the list reads that. Whenever the copy isn't ready, the list does exactly what it did before. One setting, `telegramHistoryView.enabled: false`, switches the copy off.

## What to Tell Your User

- **Smoother app, fewer stalls**: "I fixed a slowdown where opening the conversation list in the app could freeze me for up to half a minute."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation list without server stalls | Automatic |

## Evidence

- Unit: `tests/unit/telegram-list-log-view.test.ts`, `tests/unit/message-log-rotation-matches-old-code.test.ts`, `tests/unit/message-log-rotation-real-size.test.ts`.
- Integration: `tests/integration/conversation-list-log-view.test.ts`.
- E2E: `tests/e2e/conversation-list-log-view-alive.test.ts` (fails against the old list producer with one log read per topic; passes with none).
