# The dashboard PIN goes only to your private chat

<!-- bump: patch -->

## What Changed

The dashboard PIN used to be pinned in the Telegram group, where every member could read it. It was also posted when you typed "fix dashboard" and written into a status report.

When your private chat with the bot is available, the agent sends the PIN there: once per PIN, and again whenever you or the agent asks. The pinned group message keeps the dashboard link and says the PIN was sent privately.

If you have never opened a private chat with the bot, the group message keeps the PIN for now, so you're not locked out, and links to that chat. As soon as you say hi there, the agent sends the PIN and takes it off the group message.

Agents ask the server to send the PIN (`POST /dashboard/pin/send-private`); they never read it. Existing agents' instructions are updated to match.

## What to Tell Your User

- **Private PIN**: "Your dashboard PIN can come to your private chat with me. Open a private chat with me and say hi so I can send it there and remove it from the group."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Send the PIN privately | `POST /dashboard/pin/send-private` (answers `{ sent }` or `{ sent: false, reason }`, never the PIN) |

## Evidence

- Unit: `tests/unit/identity-piece1d-pin-private.test.ts`, plus the dashboard-message, notification and tunnel suites.
- Throwaway: see the PR.

- Release1989 readiness:69privacy/masking/delivery unit checks,39HTTP boundary checks,14production lifeline lifecycle checks and TypeScript passed. The HTTP fixture uses the real Telegram adapter and cleans its callback timer. A missing-method rejection was reproduced before the repair; no production security check was weakened. Full exact-head verification remains with the shared coordinator.
