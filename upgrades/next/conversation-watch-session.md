<!-- bump: patch -->
## What Changed

Conversations: each Telegram or app conversation's page now shows whether a session is running for it, with a "Watch the session" link that opens it on the Sessions page, like the app's Open session button.

## What to Tell Your User

When you open a conversation on the dashboard, you can now jump straight to the session answering it with "Watch the session". If nothing is running, the page says so. Nothing to do.

## Summary of New Capabilities

A link from a conversation to its running session on the dashboard.

## Evidence

- Unit: `tests/unit/console-conversation-session.test.ts`, `tests/unit/console-conversations-dom.test.ts`.
