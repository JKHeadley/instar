---
title: "Mobile device keys — each phone gets its own owner-approved, individually revocable key"
slug: "mobile-device-keys"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
eli16-overview: "mobile-device-keys.eli16.md"
status: "draft"
review-convergence: "2026-11-01T00:23:16.368Z"
review-iterations: 6
review-completed-at: "2026-11-01T00:23:16.368Z"
review-report: "docs/specs/reports/mobile-device-keys-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Echo under the operator standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); 24h autonomous app session approved by Justin 2026-10-31, topic 134088"
---

## 1. Problem

The mobile pairing link (docs/specs/mobile-pairing-link.md) gives the Instar iPhone app the agent's full API token. That token cannot be taken back from one phone (the only rotation signs out everything), and agents hold the same token, so nothing the app sends can be told apart from an agent. CMT-1179 blocks the fleet flip of pairing on fixing the first problem. Operator chat from the app (a separate spec, `mobile-operator-chat`) needs the second.

## 2. Design

### 2.1 A key per phone, in the Secure Enclave

At pairing, the app creates a P-256 key in the iPhone's Secure Enclave (non-exportable, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), one key per agent pairing (a fresh key every pairing; never reused across agents or re-pairings). The app sends the public key with the redeem request.

`POST /mobile/pairing-codes/redeem` (the pairing route; transport, Host, tunnel and limiter rules unchanged) now **requires** `devicePublicKey` (base64url of the 65-byte uncompressed X9.63 point, validated on P-256; a key already on record for any device is refused) and **no longer returns the API token**. It returns `{ deviceId, agentName, status: "pending" }` and nothing else; the confirmation code from 2.2 is never returned by any route. At most 10 devices may be pending at once, checked atomically at redeem (`429` beyond).

### 2.2 The owner confirms each phone with a code sent privately in Telegram

A pairing code can be minted by anything holding the API token, including an agent session, so redeeming a code never makes a device usable by itself. Every new device starts `pending` and becomes `active` only when someone types, **into that phone's app**, a confirmation code that was sent **only to the owner's private Telegram chat**.

- On a successful redeem the server generates a 6-digit confirmation code (from `crypto.randomInt`) and keeps only an HMAC-SHA-256 of it under a random key held in process memory (never written to disk), so a reader of the device file cannot enumerate the million possible codes offline. A server restart therefore voids an outstanding code; the app shows "expired" and the operator pairs again. The server and sends it with `sendToOwnerDM`: "Your code to pair a phone with «agent» is 482 913. Type it into the Instar app only if you are pairing a phone right now. If you did not start this, tap Decline. Don't send or show this message to anyone, including me." The device name follows as untrusted text in a fixed position. The message carries one **Decline** button (`md:d:<24-hex nonce>`); a tap counts only when it is authentic (read from Telegram's own updates, or forwarded with `callbackDecision.verified === true`), from the owner, in the owner's private chat. It declines the device. A session cannot forge that tap through the API.
- **Redeem waits for the send.** The redeem answers only after the DM's real outcome. "Delivered" means Telegram's `sendMessage` returned a `message_id` for the owner's private chat (Telegram accepted it; it says nothing about the owner having read it). If that does not happen within 10 seconds (for example the owner has never messaged the bot, or the send is held for the serving lease), the pending record and its code are deleted and redeem answers `409 { error: "approval-unavailable", detail }` in plain words ("open a private chat with the bot and send it any message, then ask for a new link"). A held send may still reach the owner later; that code then confirms nothing (its device no longer exists) and is never counted as a wrong guess. A consequence: pairing only succeeds on the machine that holds the serving lease, which is also the machine that receives the owner's Telegram messages and taps.
- **Lease changes.** Pending approvals live on the lease holder only. When this machine loses the serving lease, it marks its pending devices `expired` (the app shows "expired", pair again), and `POST /mobile/device/confirm` refuses (`409 { error: "approval-moved" }`) on a machine that does not hold the lease, never counting it as a wrong guess. So the machine scanning inbound messages is always the one holding live codes.
- **Restarts.** The HMAC key lives only in process memory, so at boot every `pending` device is marked `expired`; a confirm for it answers "expired" and is never counted as a wrong guess.
- **Guessing budget.** Across all devices, wrong codes share one budget: once 10 wrong codes have been recorded in the last 24 hours, **every** confirmation attempt (on any pending device, right or wrong) and every redeem is refused (`429 { error: "pairing-paused" }`) until the oldest of those 10 ages out, and one attention item is raised for the owner. The budget is recorded in the device registry file with each wrong attempt, in the same synchronous write that records the attempt, so it survives restarts and concurrent confirmations cannot both slip under it (the server is single-process; each confirm reads, checks and writes the file synchronously). This bounds blind guessing at 10 in a million per 24 hours.
- **The code never travels through a conversation.** Any inbound Telegram message containing a live pending code (any 6 digits, spaced or not, that match a pending device) declines that device, and the owner is told in the private chat that the code was sent somewhere it should not go. The check runs on both inbound paths (`/internal/telegram-forward` and the adapter's own polling) **before** the message is logged to history or forwarded to another machine. It runs on the lease holder, which (above) is the only machine with live codes. A screenshot of the code cannot be scanned, which is why the message tells the owner to tap Decline rather than tell the agent.
- The app shows a code box; the operator types the code; the app sends `POST /mobile/device/confirm { code }` signed by the pending device (2.3). A correct code activates the device. Three **distinct** wrong codes decline it (the record keeps the HMACs of wrong codes already tried, so replaying one captured wrong attempt never consumes another try), and the owner is told in the same private chat. The code expires with the pending device, 15 minutes after redeem (`expiresAt` is stored, so a restart cannot leave it pending forever).
- **What this anchors, and what it does not.** The code exists in the owner's private chat and, server-side, only as an HMAC under a key held in process memory. No route returns it and the Bot API cannot read back sent messages, so anything that reaches the agent only through its API (any remote holder of the API token) cannot learn it. Entering it into the phone proves that phone's holder can read the owner's Telegram. **Out of scope: a process running as the agent's OS user.** Such a process can read files the server writes (for example the outbound message store, which holds a message body while it is in flight), the bot token and the lifeline secret; this is the same cooperative boundary as the lifeline secret. The operator-chat spec must therefore not treat a device principal as proof against a hostile local process, only against remote token holders and agent sessions acting through the API.
- Redeem is refused (`409 { error: "approval-unavailable" }`) when the owner cannot be messaged: no Telegram adapter or no configured owner (`getOwnerUserId()` undefined).

### 2.3 Device-signed requests

An active device authenticates with its key instead of a bearer token. Headers `X-Instar-Device: <deviceId>`, `X-Instar-Device-Time: <unix ms>`, `X-Instar-Device-Sig: <base64url DER ECDSA-P256-SHA256>` over:

```
instar-device-v1\n<deviceId>\n<paired host>\n<METHOD>\n<req.originalUrl>\n<time>\n<hex SHA-256 of the raw body>
```

- **Verification:** the device exists and its status is allowed for the route (2.4), the time is within ±60 s, the signature verifies with **low-S and strict DER enforced** (a malleated signature is refused; the Secure Enclave does not guarantee low S, so the app normalizes `s` to `n − s` when needed and re-encodes minimally before sending), and the SHA-256 of the canonical string has not been seen from this device in the last 3 minutes. Keying the replay set on the canonical string, not the signature bytes, closes signature malleability. At 2,000 remembered entries for one device, new requests from that device get `429` until entries age out (no eviction).
- **Which requests a device may make: an allowlist.** A device principal may only make these requests; anything else is refused `403 { error: "device-not-allowed" }`:
  - `GET /health`, `GET /attention`, `GET /sessions` (what the Fleet view reads);
  - `GET /telegram/topics`, `GET /telegram/topics/:topicId/messages` (conversation reads for the chat spec);
  - `GET /mobile/device`, `GET /mobile/devices`, `POST /mobile/device/confirm`, `POST /mobile/devices/:id/revoke`.
  For a device principal, message history has every `sig=` parameter of a private-view link replaced by `sig=removed`, because view signatures derive from the API token and do not expire; the app opens private views only through the dashboard web view, which unlocks with the PIN. With that, no allowlisted response hands a device anything that outlives its revocation.
  Matching is done in the middleware on the request path lowercased with any trailing slash removed, against these exact patterns (`:topicId` and `:id` match one path segment); anything else fails closed with `403`. All are idempotent: the reads are, confirm on an active device is a no-op, a repeated wrong code is not counted twice, and revoke is terminal. The chat spec adds its own route with durable dedupe. The embedded dashboard pages in the app still unlock with the dashboard PIN, but in a **non-persistent** web view (`WKWebsiteDataStore.nonPersistent()`): the token that unlock returns lives only in memory while that screen is open and is gone when the app closes, so the device key is the app's only stored credential and revoking it leaves the phone holding nothing.
- **Restart gap, accepted:** the replay set is in memory; a captured request could be replayed within its 60-second window just after a restart. Every request on the allowlist is idempotent, so a replay has no additional effect.
- **Raw body:** every `express.json` instance the server mounts captures `req.rawBody` through a `verify` hook. A device request with a non-empty body and no `rawBody` (another content type) is refused `415`, never hashed as empty.
- **Placement:** the device check runs in the bearer middleware after the exact-path public exemptions and before the bearer comparison. A request carrying device headers is judged only by them. Device principals are refused on `/internal/*` routes. Routes outside the allowlist never see a device principal. `GET /health` serves its basic (unauthenticated) form to a device, as it reads the `Authorization` header itself.
- **Rate cap:** 120 device requests per minute per device, then `429`.
- **Principal:** the middleware sets `req.instarPrincipal = { kind: "device", deviceId }` for device requests and `{ kind: "token" }` for bearer requests. In this spec nothing grants extra authority to a device principal; operator-only actions are the chat spec's subject.

### 2.4 Routes and statuses

- `POST /mobile/device/confirm` accepts the device's own signature while it is `pending` (to confirm) or `active` (a retry after a lost response answers `{ status: "active" }` and changes nothing).
- `GET /mobile/device` accepts the signature of the device itself in any status except `revoked` (records in `pending`, `declined`, `expired` are kept 24 hours), and answers only `{ status, deviceName, approvedAt? }`, so the app learns the outcome.
- `POST /mobile/devices/:id/revoke`: bearer may revoke any device; a device may revoke only itself (`:id` equal to its own id), in any non-revoked status. Revocation is always allowed because it only removes access.
- Every other device-signed route requires `active`.
- `GET /mobile/devices` shows `status` for each device and the `fingerprint` (first 16 hex of SHA-256 of the public key) for active and revoked devices only; never a pending device's fingerprint or match code, never a public key.

### 2.5 The device record and the cap

`.instar/state/mobile-devices.json` holds `{ id, deviceName, label, pairedAt, status, publicKey, fingerprint, expiresAt?, approvedAt?, revokedAt?, host }`. `revoked` is terminal and kept as a tombstone. The cap never evicts an `active` record: pruning removes expired and declined records first (after 24 hours), then the oldest revoked tombstones beyond 200; at most 10 pending records exist at once (the 10-live-codes limit already bounds this). Writes stay synchronous with an atomic rename.

### 2.6 What the app holds, and shipping order

The app holds its device id and the Secure Enclave key reference, nothing else. This change ships **together with** the pairing link (docs/specs/mobile-pairing-link.md) as one release: the token-returning redeem described there is never released, so no phone ever receives the API token through pairing and there is nothing to retire.

### 2.6a Persistence is part of the decision

Every state change that matters for authority (create pending, activate, record a wrong code and the shared budget, decline, revoke) is a synchronous read-check-write of the registry file, and the server answers success only after the atomic rename succeeded. If the write fails, the request answers `500` and nothing changed: there is no in-memory copy of device state to diverge, because every check reads the file. A restart therefore cannot resurrect a revoked device or forget a recorded wrong code.

### 2.7 Configuration

Same gate as pairing (`mobilePairing.enabled`, development-agent default). While the gate is off, the middleware ignores device headers (they authenticate nothing).

## 3. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Device-signed request accepted | `invariant` | Exact ECDSA (low-S, strict DER) against a stored key; time window; replay set; status. |
| Device becomes active | `invariant` | Only the pending device's own signed request carrying the code sent to the owner's private chat (hash match, 3 tries, 15 minutes). |
| Redeem refused when the owner cannot be messaged | `invariant` | Fixed check on adapter and owner. |
| Device request allowed | `invariant` | Fixed allowlist of idempotent routes. |
| Pairing paused | `invariant` | 10 wrong codes in 24 hours. |
| Device voided by a leaked code | `invariant` | A live pending code found in an inbound operator message (HMAC match). |
| Revocation | `invariant` | Always allowed for bearer; a device only for itself. |
| Device rate and replay caps | `invariant` | Fixed limits answering 429. |

## 3a. Signal vs authority

All blocking decisions are cryptographic or exact checks. The human step, confirming a phone, needs a code delivered only to the owner's private chat; no detector gains authority.

## 4. Multi-machine posture

machine-local-justification: physical-credential-locality — a device record binds a key to one machine's hostname: the signature covers that host and only the machine serving it accepts the device; prohibited-by=the pairing spec's one-machine-per-hostname rule, TEMPORARY until multi-host serving is designed.

- `.instar/state/` is git-ignored, so device records do **not** replicate. Each record lives on the machine that redeemed it, which (by the pairing spec's mint rule) is the machine serving the paired host. The confirmation code is sent from that machine through its own Telegram adapter; if that send is held for the serving lease or forwarded, redeem fails as described in 2.2 rather than letting the code arrive late.
- `GET /mobile/devices?scope=pool` reads every machine's records (proxied-on-read).
- **Revocation** is applied by the machine holding the record, which is the machine serving the phone's paired hostname. `POST /mobile/devices/:id/revoke` on that machine takes effect immediately. On another machine it forwards to each online peer through the authenticated pool fan-out and reports which machine held and revoked it; if no peer confirms, it answers `202 { pending: true }`, keeps the revoke in a small durable outbox and retries. **Until a holder confirms, the phone may still have access** (a peer can be unreachable over the mesh while still serving its public address). The response says so in plain words, and the CLAUDE.md section tells the agent to revoke on the holder directly, through its public address, when the operator wants it immediate.
- **Tunnel move:** if the paired hostname moves to another machine, that machine has no record, so the phone gets `401`, the app shows "needs pairing again", and the operator pairs again. Serving one hostname from several machines remains unsupported, as in the pairing spec.

## 5. Frontloaded Decisions

- **Wire format frozen:** Secure Enclave P-256; 65-byte X9.63 public key; DER ECDSA-SHA256 with low-S; canonical string `instar-device-v1` including device id and paired host; `req.originalUrl`.
- **Owner confirmation by a 6-digit code sent only to the owner's private chat and typed into the phone**, 3 tries, 15-minute expiry.
- **Device principals use a fixed allowlist of idempotent routes**, none returning token-derived data; the dashboard web view keeps the PIN.
- **Redeem waits for the DM to be delivered**; a 24-hour budget of 10 wrong codes pauses pairing and confirmation; a code seen in a conversation voids its device; the DM has a Decline button; pending devices expire at boot.
- **CMT-1179 scope, narrowed deliberately:** the fleet prerequisite is per-device revocability, which this delivers. Serving one hostname from several machines, and credentials surviving a tunnel move, stay unsupported (the pairing spec refuses the first at mint; the second means re-pair) and are removed from the prerequisite; this change updates the pairing spec's text to match.
- **Redeem stops returning the API token** (breaking for the TestFlight app only, updated in the same release).
- **Device records machine-local**, pool read, revoke forwarded with an outbox; tunnel move means re-pair.
- **Ships in one release with the pairing link**; the token-returning redeem is never released.
- **Authority changes are acknowledged only after the registry write succeeds.**
- **The app's dashboard web view is non-persistent**; the device key is the only stored credential.
- **Pending approvals expire when the lease moves; confirm only on the lease holder.**
- **No per-request Face ID** (the app locks behind Face ID; a prompt per signature would make polling unusable).

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** integration and E2E tests run redeem → code to the owner DM → signed confirm → signed read, on a real server boot.
- **dev-agent-live:** live on the development agent (Echo); the operator pairs the TestFlight app and types the code from Telegram; one revoke is confirmed by a refused signed request.
- **fleet:** the `mobilePairing` default flips after the dev-agent proof.
- **graduation criterion:** one device paired, approved and used on the development agent; one revoke refusing the next signed request; zero device activations without a correct code (audited in `logs/mobile-devices.jsonl`).
- **dark-window:** if the criterion is not met within 30 days of this release, the reason and a new date are recorded on CMT-1179.

## 6. Rollback

`mobilePairing.enabled: false` turns off pairing and device authentication. Device records are inert JSON. The supported rollback is that switch (pairing and device authentication off). The token-returning redeem is never reintroduced: a code revert of this change must also revert the pairing link, which ships in the same release.

## 7. Tests

- Unit: a failed registry write leaves the device unchanged and the request answers 500 (activation, wrong code, revoke); canonical string; real P-256 signatures accepted; wrong key, tampered body, shifted time, malleated (high-S / re-encoded DER) signature, and replay refused; public-key validation and duplicate-key refusal; status transitions and merge; cap never evicts active.
- Integration: losing the lease expires pending devices and a confirm elsewhere answers 409 without counting; the owner's Decline tap declines (a non-owner or unverified tap does not); device message reads have `sig=removed`; a path in another case or with a trailing slash matches the allowlist the same way; after a restart pending devices read `expired` and a confirm is not counted; a failed owner DM deletes the pending device and answers 409; after the 10th wrong code in 24 hours every confirm (on any pending device) and every redeem answers 429, including across a restart; an inbound message containing a live code voids its device; a device GET outside the allowlist → 403; replaying one wrong confirm never uses a second try; a restart voids the outstanding code; redeem needs a key, returns no token and no code, and is refused without owner / adapter; the code reaches only the owner DM; the pending device's signed confirm with the right code activates; three wrong codes decline; an expired code fails; an 11th pending device is refused; a device POST to any unlisted route → 403; a pending device reads only its own status; an active device reads `/telegram/topics`; a device cannot revoke another device; revoked → 401; non-JSON body with device headers → 415; gate off → device headers authenticate nothing.
- E2E: production boot wires the verifier into the middleware (alive on a development agent).
- Live-user-channel proof: the development agent pairs the TestFlight app, the owner types the code from the private chat, the app's Fleet card loads through device auth, then revoke.
