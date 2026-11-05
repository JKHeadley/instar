## What Changed
Adding a phone no longer needs a code to be read and retyped. The owner's private Telegram message now has an Approve button beside Decline, and the pairing page and the legacy dashboard's Phones tab have Approve on each waiting phone, behind the same unlock that shows the code. An already paired owner phone on the same machine can list and approve a waiting phone with Face ID (`GET /mobile/pairing-requests`, then challenge, approve or decline). Each approval is bound to one waiting phone, works once, ends when that pairing ends, and a late, repeated or wrong answer refuses with a plain reason. The redeem answer and `GET /mobile/device` now tell a waiting phone `confirmWith`, `fingerprint` and `expiresAt`, so the app can wait instead of asking for a code. If a link is used by two phones, or two phones wait at once, Approve is refused and the code or Decline remains. A phone paired for someone other than the owner stays code-only. The code keeps working for older apps, and stays readable after Approve because an older app finishes on its code box. Off switch: `mobilePairing.approve.enabled: false`.

## What to Tell Your User
- **Adding a phone**: "When a phone asks to pair, you can tap Approve in your private Telegram message or on the pairing page instead of typing a code. Only approve if you are pairing a phone right now and the key shown matches the app. The code still works if the app asks for it."

## Summary of New Capabilities
- Approve or decline a waiting phone from the owner's private Telegram chat, the pairing page, the legacy Phones tab, or an owner phone with Face ID.
- A waiting phone can read where its approval is waiting and move on by itself when it is approved.

## Evidence
Three test tiers in tests/unit/mobile-pairing-approve.test.ts, tests/integration/mobile-pairing-approve.test.ts and tests/e2e/mobile-pairing-approve-alive.test.ts, plus page tests in tests/unit/dashboard-pair-page.test.ts and tests/unit/dashboard-phones.test.ts. The E2E test drives a real AgentServer boot, including the Approve tap through `/internal/telegram-callback` with the lifeline secret, and an unproven tap that approves nothing. Not yet proven: the real iPhone app and a real Telegram tap.
