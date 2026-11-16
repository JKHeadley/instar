<!-- bump: patch -->
## What Changed

An owner phone can now ask its agent for a pairing code for a computer (docs/specs/mac-qr-pairing.md). `POST /mobile/pairing-codes` accepts an owner device's signed call with `forDevice: { publicKey, name }`. The code is always the owner's, lives 5 minutes, counts against a device limit of 5 an hour inside the shared 10, and can be redeemed only by that public key (`400 wrong-device` otherwise, code spent). A computer's pending record carries `deviceKind: 'computer'` (display only), so the owner's Telegram message and the phone's waiting list say "a computer". No new approval path: the device still waits for an existing one (owner phone Face ID, Telegram, dashboard).

instar.sh gains `/api/pair-drop/:id`, a best-effort mailbox on Vercel Runtime Cache that holds a sealed blob for 120 s and never reads it, and a `/pair-mac` page. The Mac app shows a QR code; the iPhone app scans it, seals the agent's pairing link to the Mac, and leaves it there.

## What to Tell Your User

You can now connect the Instar Mac app without pasting anything. Open "Pair an agent" on the Mac, scan the code with the Instar app on your iPhone (tap +, then "Scan pairing code"), click Pair on the Mac, and approve it with Face ID on your phone. Pasting a link still works.

## Summary of New Capabilities

- Owner phones can mint a key-bound pairing code for a computer: `POST /mobile/pairing-codes` with `forDevice`.
- `deviceKind: 'computer'` on pending devices; `client: "computer"` in `GET /mobile/pairing-requests`.
- instar.sh pair-drop mailbox for QR pairing.

## Evidence

- Unit: `tests/unit/site-pair-drop.test.ts`.
- Integration: `tests/integration/mac-qr-pairing.test.ts`.
- E2E: `tests/e2e/mac-qr-pairing-alive.test.ts`.
