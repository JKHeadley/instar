# Messages sent from the Instar app can be checked as really coming from your phone

<!-- bump: patch -->

## What Changed

Increment 2 of docs/specs/mobile-native-conversations.md (signed records, §4.6, §4.8, §4.9), behind the same `mobilePairing.native.enabled` switch as increment 1 (omitted ⇒ the development-agent gate; read at boot).

- **Machine receipt.** Every message sent from the app (a native conversation, or a Telegram topic) is stored with the phone's signature, the exact signed body (`bodyB64`, always with `bodySha256`), and this machine's receipt: an Ed25519 signature by the machine identity key over (sha256 of the phone's canonical request, `receivedAt`, `machineId`), naming its key (`signerKeyHash`). When an invite or desktop code was removed, the original body is stored nowhere; only its hash and this machine's signed redaction attestation over (bodySha256, sha256 of the stored text, kinds) are kept.
- **Device-key ledger** `.instar/mobile-device-key-ledger.jsonl` (new `MobileDeviceKeyLedger`): append-only, never pruned, machine-signed activation and revocation rows keyed by the full key hash. The device confirm route writes the activation row first and the registry second; revocation likewise (a failed ledger write never blocks a revocation). Every boot reconciles the two in both directions: backfill a missing activation (`telegram-dm` for phones approved before this change) or revocation, and complete a revocation the registry missed. No route accepts rows; the ledger grants nothing.
- **Verdicts.** `verifyRecordedOrigin` returns exactly `none` / `unknown` / `failed` / `verified` / `redacted` (key taken from the ledger, strict DER low-S, path must name the record's conversation, key lifetime judged by the machine's `receivedAt`, ±60 s between the phone's time and `receivedAt`, receipt and redaction signatures checked against the key the machine held at that time in the signing-key history; unreadable history ⇒ `unknown`, never `failed`). History and sync reads now return the real verdict, and the `[app:…]` session tag says "📱 signed" only for `verified`.
- **Ledger replication.** New replicated-store kind `mobileDeviceKeyLedger` (journal kind `mobile-device-key-ledger-row`), on whenever native conversations are on. A peer's row is accepted only when it verifies under the pinned identity key of the machine it names.
- **Telegram history join.** With native conversations on, `POST /mobile/chat/:topicId` also persists the message (with origin and receipt) in the app conversation store under `telegram:<topicId>` before dispatch, and the Telegram history row carries that `eventId`. `GET /telegram/topics/:id/messages` read by a device joins each row by `eventId` and returns `originVerified`; app-sent messages whose Telegram row has rotated away are returned from the store. Bearer reads are unchanged.
- The native conversation list now lists only native conversations (app-sent Telegram copies kept in the store are not listed as app rows).
- CLAUDE.md: the Native app conversations section's "signature checking is not built yet" line is replaced in place on update.

## What to Tell Your User

When you send me a message from the Instar app, I now keep proof that it came from your paired phone, signed by your phone and countersigned by the machine that received it. The app can show a "signed" mark on those messages, a warning if a stored message has been altered, and "couldn't check" when a machine has no way to check it. This also works for messages you send from the app into a Telegram topic. For now this is switched on for the development agent only.

## Summary of New Capabilities

- `originVerified` on app history (`/mobile/chat/app/:key/messages`, `/events`) and on a device's read of `/telegram/topics/:id/messages`.
- `.instar/mobile-device-key-ledger.jsonl` and the `mobileDeviceKeyLedger` replicated store kind.

## Evidence

Unit: each verifyRecordedOrigin check on both sides; the exact and redacted text checks (valid and invalid attestation); lifetime by receivedAt with a phone clock 50 s slow; an old receipt still verified after a real machine key rotation and `unknown` when the key history is unreadable; a receipt reused on another path fails; ledger/registry reconciliation after a crash between the writes for activation and revocation in both directions; backfill idempotency; replicated row acceptance and rejection; the CLAUDE.md wording migration. Integration: native message verified in history, sync and the session tag; a tampered stored text reads failed; a redacted message reads redacted with no copy of the token on disk; ledger-first revocation keeps earlier messages verified; a device's Telegram history read returns verified for an app-sent message, none for a Telegram-typed one, unknown for a missing store event, and the store copy after rotation. E2E: on a real boot the operator message reads verified and the session tag is signed.
