## What Changed
- **The approval names the chat.** When a browser is set up for dashboard Conversations, the dashboard says which private Telegram chat the approval arrives in, by the bot's own name: "your private Telegram chat with Echo Agent (@bot), not a group". `GET /mobile/browser-devices/status` carries `approvalChat` and `ownerPhoneApproves`.
- **The iPhone comes first.** When a paired owner iPhone can approve, the setup answer says `approval: owner-phone` (with `telegramBackup`), and the dashboard leads with "Approve it on your iPhone: open the Instar app and confirm with Face ID." If the Telegram copy cannot be sent but the phone can approve, the setup waits for the phone instead of failing.
- **Waiting devices say what they are.** `GET /mobile/pairing-requests` rows carry `client` (`browser` or `phone`).

## What to Tell Your User
When you set up a browser for your conversations, the dashboard now tells you exactly where to approve it, and if your iPhone is paired it simply asks you to approve on the phone with Face ID.

## Summary of New Capabilities
- Named approval chat; phone-first browser approval with Telegram as backup; device kind in the pairing request list.

## Evidence
- `tests/unit/mobile-browser-devices.test.ts`: status names the chat and falls back to null; phone-first setup with and without the Telegram copy.
- `tests/unit/console-chats-model.test.ts`: the wording for both paths.
- `tests/integration/mobile-pairing-approve.test.ts`: waiting rows carry `client`.
- **The phone notification says what is waiting.** A browser or phone waiting for approval now notifies paired owner phones with "A new browser wants to use your conversations. Tap to approve with Face ID." (or the phone equivalent) instead of "Something needs you", and tells the app to open the approval.
