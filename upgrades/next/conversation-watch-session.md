<!-- bump: patch -->
## What Changed

Conversations: each Telegram or app conversation's page now shows whether a session is running for it, with a "Watch the session" link that opens it on the Sessions page, like the app's Open session button. Chats shows the same line.

Conversations door: where the Conversations view is not switched on, the Conversations door and the dashboard's first page now open Chats instead of "Conversations is not switched on here yet", and that page offers Open Chats.

## What to Tell Your User

When you open a conversation on the dashboard, you can now jump straight to the session answering it with "Watch the session". If nothing is running, the page says so. The dashboard also now opens on Chats, where you can read and reply, instead of a page saying Conversations is not switched on. Nothing to do.

## Summary of New Capabilities

A link from a conversation to its running session on the dashboard.

## Evidence

- Unit: `tests/unit/console-conversation-session.test.ts`, `tests/unit/console-conversations-dom.test.ts`, `tests/unit/console-front-doors.test.ts`.
