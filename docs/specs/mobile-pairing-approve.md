---
title: "Approve a waiting phone instead of reading and retyping a code"
slug: "mobile-pairing-approve"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-pairing-approve.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); requested by Justin 2026-11-05 09:30, topic 136110, CMT-1353"
review-convergence: "2026-11-05T19:38:16.269Z"
review-iterations: 2
review-completed-at: "2026-11-05T19:38:16.269Z"
review-report: "docs/specs/reports/mobile-pairing-approve-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## 1. Problem

Adding a phone to an Instar agent today: the phone taps a one-time link and redeems it (`POST /mobile/pairing-codes/redeem`) and is held pending. The owner gets a confirmation code in their private Telegram chat, or on the pairing code page after a PIN unlock, and types it into the app. Reading and retyping that code is the friction the operator asked to remove (2026-11-05 09:30, topic 136110, CMT-1353). He asked for the smallest version that works.

## 2. What exists (instar main f94fb584b)

- **Pending phones** live in the machine-local `DeviceRegistry` (`state/mobile-devices.json`): status `pending`, 30-minute `expiresAt`, a key `fingerprint`. Every read expires a row past its time. Device authentication reads this same registry.
- **Telegram path** (`approvalPath() === 'telegram'`): redeem needs the serving lease; it DMs the code with a Decline button whose `callback_data` is `md:d:<nonce>`; `svc.declineNonces` (memory) maps nonce to device id and is pruned when the device stops being pending. On lease loss the lease tick voids codes and nonces and expires Telegram-path pending rows. The tap is judged by `TelegramAdapter.handleMobileDecline`: `verified` (read from `getUpdates`, or the lifeline proved the tap with the ingress secret), the sender is `getOwnerUserId()`, and the chat is the owner's private chat.
- **Dashboard path** (`dashboard`, no Telegram owner, native conversations on): the code is held in memory; `GET /mobile/pairing-approvals` and `POST .../:id/decline` need a token principal AND `X-Instar-Operator-Session` (a PIN unlock). The Bearer token alone and any device are refused. No lease. Both surfaces use them: `dashboard-pair/pair.js` (`/dashboard/pair`, which the console's Phones item opens) and `dashboard/phones.js` (the legacy tab).
- **Confirm** `POST /mobile/device/confirm` (signed as the pending phone): ledger row first if a key ledger exists, then `applyConfirm`; a wrong code is a strike; `pairingPaused()` refuses. An already `active` device answers `{status:'active'}` whatever the code.
- **Status** `GET /mobile/device` is already signed as the pending phone and allowed for `pending`, `active`, `declined` and `expired`.
- **Owner-phone Face ID** (`mobilePermissionsRoutes.ts`): an active owner phone, over local TLS, gets a single-use challenge from `ActionChallengeStore`, bound to device, Host and one exact action line, and signs that with its presence key (`verifyPresenceSignature`). The presence key is a second Secure Enclave key that signs only after Face ID or the passcode.

## 3. Design

One new way to finish a pairing, reached from three places. The code stays in every case as the fallback.

### 3.1 One funnel

`svc.approvePending(deviceId, via, { approvedBy? })` is the only new activation path. It runs synchronously, so no two answers interleave:

1. Feature on (§3.6), else `off`.
2. Read the row. Not `pending` (unknown, expired, declined, already active, revoked) → `ended`.
3. An MSP's phone → `code-only`; a contested phone (§4) → `contested`. Both keep Decline and the code.
4. `pairingPaused()` → `paused`. A pause means someone may be guessing, and the pending phones may be theirs.
5. Not dashboard-pending and this machine lacks the serving lease → `moved`, same rule as confirm.
6. **Another phone is also pending on this machine → `another-phone-waiting`**, nothing approved (§4, stolen link).
7. Ledger row first when a key ledger exists (failure → `failed`, nothing consumed, the owner can tap again), then `applyConfirm(ok)`. If the registry does not now say `active` → `failed`.
8. Drop the code, the dashboard code and every nonce for that device. Answer `approved`.

`approvedVia` names the proof: `telegram-dm` for the Telegram button, `dashboard-pin` for the dashboard button, `owner-phone` (new) for a Face ID approval, which also records `approvedBy: <approver device id>` on the row. The key ledger stores `approvedVia` as a string up to 32 characters, so the new value needs no ledger change.

One-use, expiry, and binding all come from this: an approval names one device id; that id's row is `pending` exactly once, and stops being pending at its own expiry.

### 3.2 Telegram

The DM keeps the code and gains an Approve button: `md:a:<nonce>`, next to `md:d:<nonce>`, same nonce and same lifecycle, so both buttons die together. `TelegramAdapter.handleMobileApprove` applies exactly the checks of `handleMobileDecline` (`verified`, owner sender, owner's private chat) and calls `svc.approveByNonce`. The nonce is 96 random bits, memory only. `/internal/telegram-callback` passes `verified: callbackDecision.verified`, so a tap the lifeline did not prove is refused even in the window before the ingress guard is armed. Its existing dedupe applies the same `callbackQueryId` once.

The toast states the outcome in plain words. On `approved` the buttons are removed (best effort) and the code stays, with a short message saying to type it if the app still shows a code box. On a decline the text is replaced. Late or repeated taps answer "This pairing has already ended."

The message leads with the decision, labels the phone's name as something it chose itself, and shows the key:

```
A phone is asking to pair with <agent>. Approve only if you are pairing a phone right now and this key matches the one the app shows.

Phone key: ABCD-EF01-2345-6789
Phone name: <name> (the phone chose this name, so don't rely on it)

If you did not start this, tap Decline.

If the app asks for a code instead: Your code to pair a phone with <agent> is KITE-4172. Don't send or show this message to anyone, including me.
```

An MSP's phone (a phone paired for someone other than the owner) gets today's message unchanged: the code and Decline, no Approve. Its link travels through other channels by design, the owner cannot see that phone, and handing over the code is what binds it to that person.

### 3.3 Dashboard

`POST /mobile/pairing-approvals/:id/approve`, behind `operatorOnly`, the same access that reveals the code. No new PIN prompt: the page already holds the session. It requires `isDashboardPending(id)` (else `404 not-pending`) and `approvalPath() === 'dashboard'` (else `409 approval-moved`), so **the PIN never approves a phone on an agent with a Telegram owner**, exactly as it never revealed that phone's code. Refusals use 404/409/429 with a plain `detail`, never 403, which the page reads as "session gone". Each row of `GET /mobile/pairing-approvals` gains `canApprove`. Both `pair.js` and `phones.js` show an Approve button above the code on a row that can use it, with the same condition beside it: approve only if you are pairing this phone right now and the key matches the one the app shows.

### 3.4 An already paired owner phone on this agent

On the existing device allowlist, `ownerOnly`, with the same gate as Face ID permission slips (local TLS, `activeOwnerPhone`, presence key on file):

- `GET /mobile/pairing-requests` lists waiting phones on this machine: `{deviceId, deviceName, label, role, personName, fingerprint, requestedAt, expiresAt, canApprove}`, never a code.
- `POST /mobile/pairing-requests/:id/challenge` with `{action: 'approve' | 'decline'}` → `{challenge, expiresAt}`. The action line is `<action> <deviceId> <fingerprint>`, built by the server from the row.
- `POST /mobile/pairing-requests/:id/approve` and `/decline` with `{challenge, presenceSig}`.

The presence key signs `instar-pairing-approve-v1\n<approverDeviceId>\n<host>\n<challenge>\n<line>`. The challenge lives in a `BoundSecretStore` (the console ticket's) keyed on approver plus line and bound to the Host; it is deleted before it is judged, so it cannot be replayed or moved to another phone or another action. The bearer token is refused: a session can list nothing and approve nothing here.

When a phone goes pending and an owner phone able to answer exists here, one `notice` push is sent to the phones on this machine, through the existing budgets, with no phone name or key in it (it cannot target owners, so an MSP's phone gets the same "Something needs you" as for other notices). An approval from a phone also tells the owner's private Telegram chat, when there is one, which phone approved which.

### 3.5 What the waiting phone learns

The redeem answer and `GET /mobile/device` (for a pending phone) gain:

```
confirmWith: Array<'telegram' | 'dashboard' | 'owner-phone' | 'code'>   // where an Approve button is waiting, best first; 'code' is always last, and alone for an MSP's or a contested phone
fingerprint: string                                                    // ABCD-EF01-2345-6789, to show large on the wait screen
expiresAt: string                                                      // ISO, when the pending pairing ends
```

`GET /mobile/device` is the status route: already signed as the pending phone, and it answers `status` for every outcome. A poll every 3 s stays inside the 120-a-minute device allowance. An app that ignores the new fields behaves as today.

### 3.6 Switches and old apps

`mobilePairing.approve.enabled` (read live): omitted means on wherever pairing is on, like `consoleTicket`; `false` removes the Approve button, the routes (503), the new fields and the two-phones notice, leaving today's code flow; a Decline tap still replaces the message text. No migration of config is needed.

An existing agent loses nothing: the code path is unchanged apart from the message's wording. A shipped app (read from source, `apps/instar-ios/InstarApp/Pairing.swift`) reads the new fields as nothing and never polls: its code box submits only a complete-looking code, and confirm then answers `active` for any code. So Approve never hides the code: it stays in the Telegram message, and the dashboard's "Approved" line repeats it. The app needs no change to keep working, only one extra step until it is updated.

## 4. Security

The typed code proved one thing a tap does not: that the person reading the chat was also holding the phone. So the design has to answer "whose phone is this tap for?". It does not close that fully: the tap is an owner's assent, helped by a key to compare and by these rules.

| Attack | What stops it |
|---|---|
| **Stolen link, the thief first** | The link works once. If the owner's phone then uses it, the second key is seen: the thief's phone becomes **contested**, Approve refuses it, the owner is told, and only the code or Decline remain. The tombstone is a hash of the link code, in memory, for the pending life, and gives one notice per link. If the thief's phone was already approved when the second key arrives, the owner is told that phone is now paired, with its key, and to remove it if it is not theirs. On the dashboard path there is no chat to tell; the card simply loses its Approve button. |
| **Stolen link, the owner's phone not opened yet** | Nothing marks it: one phone is waiting, and it is the thief's. The owner gets a message they did not expect, which says to approve only if they are pairing right now and the key matches the app. **Accepted residual.** A tap on an unexpected message with no phone in hand pairs the thief's phone. The name is labelled untrusted, every paired phone shows in Phones, and removal is one tap. |
| **Two phones waiting** (two stolen or mixed-up links) | `another-phone-waiting` refuses every Approve until one is declined, so a reflex tap cannot pick. If the owner finishes one by code, each phone left waiting beside it becomes contested, so its old button cannot then approve it alone. The rule is per machine: two links on two machines are two separate waits. **Accepted residual:** the owner declines the wrong one of two, or the older one expires, and the survivor can then be tapped. Contesting both when a second appears would close this, at the cost of sending every honest retry back to the code, and retries are the common case. |
| **An MSP's phone** | Code-only (§3.2). A tap would hand that person's grants to a phone the owner cannot see. |
| **Spoofed Telegram answer** | The tap must carry a 96-bit nonce sent only to the owner's chat, be proven (`verified`), come from the owner id, in the owner's private chat. A session posting to `/internal/telegram-callback` with the API token has neither the lifeline secret nor the nonce. Saying "I'm the owner" in a message carries no authority. |
| **Replayed approval** | Telegram: the row stops being pending, the nonce is dropped, and the same callback id is deduped. Phone: the challenge is single use and the device signature passes the replay guard. Dashboard: the row is no longer pending. All answer with the "already ended" reason. |
| **Approving the wrong phone** | Every approval names one server-made device id whose key never changes. A phone's signature covers a line carrying its id and key fingerprint, so a swapped id fails. A nonce maps to exactly one id. A pending phone cannot approve itself: only an active owner phone passes the gate. An MSP phone cannot approve. |
| **An agent session** | The bearer token alone reaches no approval. A session can mint a link (as today), redeem it with its own key, and then tell the owner "tap Approve to finish"; if the owner taps, that session holds an owner phone. Today the same session would have to talk the owner out of a code. This is social engineering, not a forged answer, and it does not cross a boundary that exists: a process running as the agent's OS user can already read the PIN and write the device registry file directly (mobile-device-keys §2.2). The awareness text says I never approve a phone myself. |
| **A remote holder of the API token** | **The one real boundary this moves. Accepted, with Approve on by default (decision by the session coordinating this work, 2026-11-05, which tells the operator): the API token already gives full control of the agent, the owner must still tap Approve on a message showing the phone and its key, and the off switch exists.** mobile-device-keys §2.2 says a remote API-token holder cannot learn the code. Minting needs only that token and redeem is public, so such a holder can create a waiting phone, and one owner tap on it gives them an owner phone, where before they could not get the code at all. A tunnel request looks like loopback, so the server cannot tell them apart. What stands in the way is the same message as the stolen-link residual: approve only if you are pairing right now and the key matches. The off switch restores the code-only boundary. |
| **Guessing or flooding** | Nothing here is guessable. A pause stops all three. Pending is capped at 10; a second pending phone only blocks Approve, and the code still works. A contested mark costs the thief a stolen link and lasts at most the 30-minute pending life. |

## 5. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `approvePending` admission (pending, MSP, contested, pause, lease, another-phone-waiting) | invariant | Enumerated registry and lease states; no judgment. |
| Contested mark (the same link from a second key; left waiting beside an activation) | invariant | Exact hash and key comparison on a fixed event. It can only remove the tap; code and Decline remain. |
| Telegram Approve tap (verified, owner, private chat) | invariant | Same exact check as the existing Decline tap. |
| Dashboard approve (operator session, dashboard-pending, approval path) | invariant | Credential gate plus enumerated state. |
| Owner phone approve (device signature, owner role, local TLS, presence signature, single-use challenge) | invariant | Cryptographic checks; same shape as permission slips. |

## 6. Multi-machine posture

A pending pairing is held by the machine that redeemed it (its registry row, its code, its nonce), and an activation authorizes that machine only, as today. An approval reaches it like this:

- **Telegram:** redeem needs the serving lease, so the machine that sent the message is the one receiving taps. If the lease moves, the tick voids that pairing, the phone's next status read shows `expired`, and a late tap on the new holder finds no nonce: "This pairing has already ended." Nothing is forwarded.
- **Dashboard:** `codePageUrl` names the host the phone redeemed on, so the page and its session are on the holding machine. On any other machine the card is not listed and the route answers `404 not-pending`.
- **Owner phone:** the phone must be paired on the holding machine and signs to it directly. `owner-phone` appears in `confirmWith` only when such a phone exists there, so no phone waits on a path that cannot answer. A phone paired only on another machine is not offered this path. Signed cross-agent or cross-machine trust is deliberately not built here; one narrow cross-agent statement (an owner phone of another agent vouching for its own pending key) is added by docs/specs/mobile-pairing-introducer.md.

Forwarding an approval to another machine is a scope decision, not something impossible: it would need signed trust between machines, which this slice deliberately omits. Locality of the credential itself is not a choice:

machine-local-justification: physical-credential-locality impossible-because="the credential an approval activates is the waiting phone's key in the holding machine's own device registry, which that machine's TLS name and device authentication read, and the nonce and code exist only in that machine's process" permanence=permanent

## 7. Tests

- **Unit:** `approvePending` both sides of each gate; contested marks; nonce one-use and shared lifecycle with Decline; the presence line; `handleMobileApprove` (unverified, not owner, group chat); page and legacy tab render and call Approve and show the refusal's reason.
- **Integration:** redeem shape and `confirmWith` per path; Bearer-only refused on all approve routes; Telegram-path device refused on the dashboard route; dashboard approve activates with `dashboard-pin` and works without the lease; two waiting refuses; late, repeat and wrong-device refusals; owner phone full challenge flow, including another phone's challenge, a swapped id, an MSP phone, no presence key; `GET /mobile/device` tells the waiting phone; the code path still works beside all of this; the switch off restores today's answers.
- **E2E:** production `AgentServer` boot with no Telegram: redeem, dashboard approve, the waiting phone reads `active` and uses a signed route. With a Telegram stub: the Approve tap through `/internal/telegram-callback`.

## 8. Rollback

Set `mobilePairing.approve.enabled: false` for the kill switch; a plain revert removes the code. Phones already approved stay paired: their rows are ordinary `active` rows. A reverted build ignores `approvedVia: owner-phone` beyond display and keeps `approvedBy` as an unread field.

## Maturation plan

- **test-agent-live:** the unit, integration and E2E tests in §7 on a real server boot.
- **dev-agent-live:** on a throwaway agent, the app's wait screen and all three surfaces with a real phone and a real Telegram tap (the app session owns this test), then the operator pairs a phone with a development agent by tapping Approve.
- **fleet:** no staged rollout. It follows `mobilePairing.enabled`, which is dev-gated, so it reaches whichever agents have pairing on, with `mobilePairing.approve.enabled: false` as the opt-out.
- **graduation criterion:** one week on a development agent with every pairing finished by a tap, no approval refused in error, and no phone removed as "not mine" after an approval.
- **dark-window:** not applicable: it ships on wherever pairing is on, so there is no dark period to bound.
- **ladder:** not applicable: follows mobilePairing.enabled, the switch is an operator opt-out
