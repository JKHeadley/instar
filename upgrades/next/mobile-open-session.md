<!-- bump: patch -->

## What Changed

The Instar iPhone app can ask which session is answering a chat: `GET /mobile/conversations/session?ref=<app:<uuid> | telegram:<topicId> | Slack conversationKey>` (signed by a paired phone, read-only). The answer is `{ active, sessionName, startedAt, framework, machineNickname, dashboardUrl, reason, ownerMachine }`. When a session is running, `dashboardUrl` opens the dashboard on this machine's permanent address, focused on that session (`/dashboard?session=<name>`); it carries no token or PIN, and the dashboard asks for its PIN as usual. When none is running, `active` is false with a plain reason, and when the chat runs on another machine, the answer names that machine. The dashboard now waits up to 10 seconds for its session list before giving up on a `?session=` link.

## What to Tell Your User

The Instar app can now take you straight from a chat to the live session answering it on the dashboard, once the app adds its "Open session" button. If nothing is running for that chat, it tells you so, and your next message starts one. You still type the dashboard PIN.

## Summary of New Capabilities

- A paired phone can ask which session drives a chat and get a dashboard link focused on it.
- An honest "no session is running" answer, or the name of the machine that runs the chat.

## Evidence

Unit tests cover the reference shapes, the link builder and both sides of each decision (running here, not running, running elsewhere, no address). Integration tests go through the real device check: active, inactive, another machine, wrong references, the agent token refused, a revoked phone refused, and the allowlist entry. A production-path test boots the server, pairs a phone, starts a conversation, and sees the answer flip from "no session" to an active link that the served dashboard reads.
