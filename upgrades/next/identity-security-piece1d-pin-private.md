# The dashboard PIN goes only to your private chat

<!-- bump: patch -->

## What Changed

The dashboard PIN used to be pinned in the Telegram group, where every member could read it. It was also posted when you typed "fix dashboard" and written into a status report.

Now the agent sends the PIN only to your private chat with its bot: once per PIN, and again whenever you or the agent asks. The pinned group message keeps the dashboard link and says the PIN was sent privately.

If you have never opened a private chat with the bot, the group message keeps the PIN for now, so you're not locked out, and links to that chat. As soon as you say hi there, the agent sends the PIN and takes it off the group message.

Agents ask the server to send the PIN (`POST /dashboard/pin/send-private`); they never read it. Existing agents' instructions are updated to match.

## What to Tell Your User

- **Private PIN**: "Your dashboard PIN now comes to your private chat with me, never the group. If you haven't messaged me privately yet, open a chat with me and say hi, and I'll send it there."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Send the PIN privately | `POST /dashboard/pin/send-private` (answers `{ sent }` or `{ sent: false, reason }`, never the PIN) |

## Evidence

- Unit: `tests/unit/identity-piece1d-pin-private.test.ts`, plus the dashboard-message, notification and tunnel suites.
- Throwaway: see the PR.
