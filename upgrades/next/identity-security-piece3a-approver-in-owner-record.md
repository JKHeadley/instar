# Only your own phone can make itself able to approve

<!-- bump: patch -->

## What Changed

Before this update, any device paired with your agent could make itself able to approve risky actions, and on a Windows PC any program could do that silently. Now the list of devices that can approve is kept in the signed ownership record your computers share. The first such device is set up with a code sent to your private chat, which you type on that device. After that, a device that can already approve lets the next one in. Removing a device that approves needs your tap in your private chat. Devices that approved before this update keep working, and you get one message listing them.

## What to Tell Your User

- **Approving devices**: "Phones that could approve before still can, and I've listed them for you once. A new phone needs a code from our private chat the first time, or a yes from a phone that can already approve."
- **Removing one**: "If someone tries to remove a phone that approves, I'll ask you first in our private chat."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| First approving device | The app calls `POST /mobile/approver/first`, then `/confirm` with the chat code, then `/sign` |
| Let another device approve | `POST /mobile/approver/request` from the new device; an approver uses `/mobile/approver/grant/draft` and `/grant/sign` |
| Who can approve | `GET /owner-record` → the owner keys |

## Evidence

- Unit: `tests/unit/identity-piece3a-approver-record.test.ts`, `tests/unit/identity-piece3a-approver-claim.test.ts`, `tests/unit/identity-piece3a-approver-ratchet.test.ts`.
