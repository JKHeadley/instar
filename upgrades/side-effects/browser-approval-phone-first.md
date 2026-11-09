# Side effects: browser approval names the chat and puts the iPhone first

## What changed
1. `TelegramAdapter.botIdentity()` (getMe, cached 1 h) gives the bot display name and username, wording only.
2. `GET /mobile/browser-devices/status` adds `approvalChat` ({name, username} or null, 1.5 s cap) and `ownerPhoneApproves`.
3. Setup answer: when the approval path is Telegram and a paired owner iPhone can approve (`isPairingApproveEnabled && approvable && ownerPhoneCanApprove`), `approval` is `owner-phone` with `telegramBackup` (whether the Telegram copy went out). If the Telegram copy fails but the phone can approve, the setup is kept instead of cancelled.
4. `GET /mobile/pairing-requests` rows carry `client: browser | phone` so the app can say a browser is waiting.
5. Dashboard wording: names the private chat ("your private Telegram chat with Echo Agent (@bot), not a group") and leads with the iPhone when it can approve.

## Why
Operator 2026-11-09: the approval message went to the private chat "Echo Agent" and was looked for in the group ("didn't get a code"); then: "Why can't the iphone app be used for this approval flow?" The phone was notified at 09:50 but the dashboard only pointed at Telegram.

## Review
1. Over-block: none added.
2. Under-block: approval authority unchanged: only Face ID on an owner phone or the owner's Telegram tap/code approve; the PIN step is unchanged.
3. Level: the setup route and status already choose the approval wording; this extends them.
4. Signal vs authority: no new authority. Keeping a setup alive when Telegram fails only matters when an owner phone that can approve exists; a pending setup still expires and still needs the owner's approval.
5. Interactions: owner phones were already notified (`notifyOwnerPhones`); the waiting list already included awaiting browsers. getMe is a read, not a send, so the quiet-by-default gate is not involved.
6. External surfaces: two new status fields, one new setup field, one new pairing-requests field (additive). The bot name comes from Telegram for this agent own bot; the browser-chosen device name is never put in wording here.
7. Multi-machine: status and setup run on the machine serving Telegram; owner phones are this machine's (unchanged rule).
8. Rollback: revert; no state.

## 6b. Operator-surface quality
- (1) Leads with the action: "Approve it on your iPhone: open the Instar app and confirm with Face ID."
- (2) No raw internals: names the chat by its display name.
- (3) No destructive action.
- (4) Plain at phone width: same card, one sentence longer.
