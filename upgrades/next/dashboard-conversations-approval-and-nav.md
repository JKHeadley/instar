## What Changed
- **Approval messages get through again.** The owner's private Telegram message with a code and Approve/Decline, sent when a browser is set up for dashboard Conversations or a new phone asks to pair, is now always sent. With quiet-by-default switched on it was filed in the quiet feed, and browser setup answered "I could not send you the approval message in Telegram". Routine automated output is still held.
- **Conversations at the top of the dashboard.** The dashboard sidebar and phone bottom bar show "Conversations" right under Home whenever dashboard conversations are on. The Work tile stays.

## What to Tell Your User
If setting up this browser for your conversations said I could not send you the approval message, try again: the approval now arrives in our private chat. Conversations also has its own place at the top of the dashboard menu now.

## Summary of New Capabilities
- Browser and phone approval messages are sent with quiet-by-default on.
- A top-level Conversations entry in the dashboard navigation.

## Evidence
- `tests/unit/notification-selectivity.test.ts`: with an enforcing gate, the approval message reaches the owner, no topic waiting state changes, and a routine send afterwards is still held.
- `notification-selectivity`, `mobile-pairing-approve`, `console-plans`: 77/77 pass.
- Checked against the live Echo server at 1280x728 and 390x844.
