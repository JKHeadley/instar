# The server no longer freezes when the app opens its conversation list

<!-- bump: patch -->

## What Changed

- **The conversation list no longer stalls the server.** The phone and Mac apps' conversation list used to make the agent's server re-read its whole Telegram message history once for every closed conversation, freezing it for 20-30 seconds at a time on an agent with hundreds of conversations. The server now keeps a memory copy of what that read returned, built once in the background and kept current, and the list answers from it.
- **Saving a message no longer reads the whole history file.** Once the message file passed 20 MB, every saved message triggered a full read of it just to check whether it was due for trimming. The line count is now tracked as messages are saved; the file is read only when it is actually trimmed.
- **Faster, quieter start-up.** The code map rebuilt at start-up rewrites only files that changed, and the check for which installed Node program to use runs in the background instead of holding the server.

## What to Tell Your User

- **Smoother app and fewer stalls**: "I fixed a slowdown where opening the conversation list in the app could freeze me for up to half a minute. The list now loads without making me re-read my whole message history, so I stay responsive."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation list without server stalls | Automatic |
| No full history read on every saved message | Automatic |

## Evidence

- Unit: `tests/unit/telegram-log-view.test.ts`, `tests/unit/message-log-rotation-no-per-append-read.test.ts`, `tests/unit/cartographer-scaffold-incremental.test.ts`, `tests/unit/node-symlink-async-probe.test.ts`.
- Integration: `tests/integration/conversation-list-no-log-scan.test.ts` (production server + real Telegram adapter, 120 closed topics, no synchronous log read).
- E2E: `tests/e2e/conversation-list-no-log-scan-alive.test.ts` (production `AgentServer` constructor).
