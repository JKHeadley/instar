# The server no longer freezes when the app opens its conversation list

<!-- bump: patch -->

## What Changed

- **The conversation list no longer stalls the server.** The phone and Mac apps' conversation list used to make the agent's server re-read its whole Telegram message history once for every closed conversation, freezing it for 20-30 seconds at a time on an agent with hundreds of conversations. The server now keeps a memory copy of what that read returned, built once in the background and kept current, and the list answers from it.

## What to Tell Your User

- **Smoother app and fewer stalls**: "I fixed a slowdown where opening the conversation list in the app could freeze me for up to half a minute. The list now loads without making me re-read my whole message history, so I stay responsive."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation list without server stalls | Automatic |

## Evidence

- Unit: `tests/unit/telegram-log-view.test.ts`, `tests/unit/message-log-rotation-matches-old-code.test.ts`.
- Integration: `tests/integration/conversation-list-no-log-scan.test.ts` (production server + real Telegram adapter, 120 closed topics, no synchronous log read).
- E2E: `tests/e2e/conversation-list-no-log-scan-alive.test.ts` (production `AgentServer` constructor).
