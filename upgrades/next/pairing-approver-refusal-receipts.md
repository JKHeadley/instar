## What Changed
- **Pairing invites say who may approve.** When an agent cannot approve a forwarded pairing invite, it now says it can't tell who is allowed to approve new connections for it (or that only that person can), instead of talking about an "owner" that could be confused with the other agent's claimed owner. It never names anyone.
- **No "✓ Delivered" after a turned-away invite.** If a forwarded invite is refused, unusable, or pairing by invite is off, the server now tells the Telegram listener it was refused, so the misleading "✓ Delivered" tick no longer follows. A valid invite waiting for Approve or Decline is still acknowledged; nothing is paired until Approve is tapped.
- The missing tick needs your agent's Telegram listener to be on a current version; if it was already running an older one, it keeps the old tick until its next normal restart. If an invite was accepted but its Approve prompt could not be sent, no tick is shown either; that is not a decline. The accepted invite may remain pending until it expires; it must not be resent automatically.
- Who may approve, and how pairing works, is unchanged. Setting up an approver and resuming a waiting invite are still separate, tracked work and are not part of this update.

## What to Tell Your User
If I can't accept a pairing invite you forward, I'll now say plainly that it's about who may approve connections for me, and you won't see a "Delivered" tick that makes it look like it went through. You can still approve it from the Threadline tab on the dashboard with your PIN.

## Summary of New Capabilities
- None new. Clearer refusal wording and an accurate delivery tick for forwarded pairing invites.

## Evidence
- `tests/unit/threadline/PairingInviteTelegram.test.ts`: each forwarded-invite path reports refused, invalid or awaiting approval; the new wording never names the invite's claimed owner.
- `tests/integration/pairing-invite-telegram-routes.test.ts`: over real HTTP, the listener's own receipt reader sees refused for unknown approver, wrong approver, unusable invite, pairing off and a send failure, and not refused for a valid invite; the invite stays consumed and secret.
- `tests/e2e/threadline/pairing-handshake-production-path.test.ts`: on the real pairing engine, a valid invite waits for approval and an unusable one is refused.
