---
title: "A phone's Face ID key counts only after the owner confirms it"
slug: sec142-presence-key-confirmed
author: Echo
tier: 2
status: draft
eli16-overview: sec142-presence-key-confirmed.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "No Single Device Lockout; Security Fixes Keep the Experience Whole"
parent-spec: "mobile-console-device-signin (presence key enrolment), mobile-device-keys (pairing approval)"
related-specs: "sec140-session-input-grant (typing needs a Face ID go-ahead; depends on this), the phone threat model (Studio document fd351c3a)"
decision-source: "Chief of Staff, 2026-11-21 07:49Z: 'SEC-142 must be fixed before or with SEC-140, since a grant is only as strong as enrolment'; 11:25Z: 'your next work is the SEC-142 design ... Spec only; no build'"
security-ledger: "SEC-142 (medium)"
approved: false
---
# A phone's Face ID key counts only after the owner confirms it

## Problem statement

An owner's phone holds a second key, the **presence key**, which signs only after Face ID, Touch ID or the phone's passcode. The agent relies on it for every Face ID check: opening the console without the PIN (which hands the phone the agent's access token), unlocking the desktop, revealing the PIN, approving sensitive actions, closing or moving sessions, and soon the typing go-ahead (SEC-140).

Today the first presence key a phone registers on a machine is accepted with only the phone's device key and a proof that the caller holds the new key (`POST /mobile/device/presence-key`, `src/server/mobileConsoleTicket.ts`). Any key passes that proof, including one made in software. Once set, it cannot be replaced without pairing the phone again. So whoever registers first wins: on a phone whose genuine app has not yet registered its key on a machine, an attacker who can make the phone's device key sign can register a key of their own and from then on pass every Face ID check on that machine.

The sign-in design accepted this window on purpose for one attacker: harmful software inside the app before it first registers its key, who could equally read a PIN typed into the same app. This spec closes the window anyway, because the typing go-ahead would otherwise inherit it, and because the window is longer than it looked: a phone has it on every machine it pairs with, until its app registers there.

## Who is affected

- **iPhone:** the device key and presence key live in the Secure Enclave and cannot be copied off the phone. The attacker is harmful software inside the app, before registration on a machine.
- **Android:** the Chief of Staff reports that the device key is held in the Android keystore and cannot be exported, with no hardware proof per device. Whether the app's presence key (`PresenceKey.kt`) is wired into registration is not something this spec can check from here: the app's source is not on this machine. Until that is confirmed, Android phones are treated as having no presence key (Phase 1 registers none), which is the case today.
- **Computers (Mac, and apps on Linux and Windows):** a computer is paired at the computer or by its local install, which is already an owner-present step. How the Linux and Windows apps store their keys is not recorded in the device registry and is asked of their owners (Open questions).

## Proposed design

### 1. A presence key is `confirmed` or `unconfirmed`

Each device record gains `presenceConfirmedVia` (absent means unconfirmed): how the owner confirmed this phone's presence key on this machine. Every Face ID check keeps working for an unconfirmed key as today; what changes is what other features may rely on (section 4).

### 2. New pairings: confirmed by the pairing approval itself

An updated app sends its presence public key, with its possession proof, in the pairing request it already makes. The owner's approval of that pairing, through any of the existing channels (a direct chat confirmation, the dashboard PIN, approval at the computer, the local install, or a person's own already-approved phone), activates the device key and confirms the presence key in the same step. The approval card says so in one line: "This also sets up Face ID for this phone." Nothing new is asked of the owner.

The pairing request is bound to the code or link the owner handed to that phone, so the confirmation inherits pairing's trust. An attacker who could make the phone sign a pairing request with their own key could equally pair a device of their own, which pairing approval already guards.

### 3. Phones that already registered a key

A key registered before this change, or after pairing by an older app, is `unconfirmed`. It may be the phone's own key or, in the window described above, an attacker's. The server cannot tell which by itself, so the owner checks once, by comparing a short code:

- The updated app computes a fingerprint of its own presence key (the first 6 characters of a hash of the public key it holds in the Secure Enclave, shown in groups of three) and shows it under "Confirm Face ID for this computer".
- The owner opens the device in the dashboard's device list (signed in, PIN-confirmed action) and sees the fingerprint of the key the server has on record.
- If they match, the owner taps Confirm: `presenceConfirmedVia: 'dashboard-pin'`. A direct chat confirmation works the same way: the agent sends the server's fingerprint to the owner's direct chat and the owner replies with the matching words shown on the phone.
- If they do not match, the key on record is not the phone's own. The dashboard says so plainly and offers the fix: remove the phone and pair it again, which clears the wrong key. The event is recorded on the security ledger as a likely compromise.

The agent offers this check once to each owner phone with an unconfirmed key (a one-tap card on the dashboard and in the app), and re-raises it in the weekly security review until every owner phone is confirmed or the owner records that a phone is not used for Face ID checks.

### 4. What relies on confirmation

- The typing go-ahead (SEC-140) under `require` needs a confirmed key; under `accept` an unconfirmed key behaves as today and is listed as a registration risk.
- Existing Face ID checks (console, desktop unlock, PIN reveal, approvals, session controls) keep accepting unconfirmed keys in this release, so no owner loses anything on upgrade. A later step, decided with the rollout evidence, can require confirmation for the console ticket, which hands out the access token; that step is the owner's decision and is not in this spec.

### 5. Shipped apps during rollout

- An older app that registers its key the old way after pairing still works; its key is simply `unconfirmed`, and the owner is offered the fingerprint check once their app is updated (an older app cannot show the fingerprint, so the offer says "Update the app to confirm Face ID for this phone").
- The pairing request field for the presence key is optional; an older server ignores it and the app falls back to registering after pairing, as today.
- No existing route changes behaviour for an older app.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A presence key sent with a pairing request is confirmed by that pairing's approval | invariant | basis: enumerable-domain; evidence: pairing approval is the owner-present step for the device key already; the presence key rides in the same request, bound to the same code or link. |
| A key registered outside pairing stays unconfirmed until the owner compares fingerprints | invariant | basis: irreversible-consequence; evidence: a wrong confirmation would make an attacker's key trusted for every Face ID check, including the access-token handout. The server alone cannot tell whose key it is. |
| Existing Face ID checks keep accepting unconfirmed keys in this release | judgment-candidate | floor: nothing an owner can do today stops working on upgrade (No Single Device Lockout); arbiter: the owner, offered a later step for the console ticket on rollout evidence; fallback: accept as today. |
| Fingerprint length (6 characters in two groups) | judgment-candidate | floor: the fingerprint is compared by a person once and only after the owner is signed in with the PIN, so it resists a casual mismatch, not a brute force (an attacker cannot choose the server's key to match the phone's); arbiter: the build may lengthen it; fallback: 6. |

## Multi-machine posture

- `presenceConfirmedVia` lives on the device record, which is machine-local, like the presence key itself (a phone registers its presence key on each machine). machine-local-justification: physical-credential-locality (the presence key is registered per machine; its confirmation belongs to that registration).
- The weekly re-raise reads every machine's device records through the pool roster and lists unconfirmed owner phones per machine.

## Migration

- Device records gain optional `presenceConfirmedVia` (absent = unconfirmed). No migration step: every existing key starts unconfirmed.
- The pairing request gains an optional `presenceKey` and `presenceProof`.

## Observability

Per machine: owner phones with a confirmed key, an unconfirmed key, no key; fingerprint checks done, matched, mismatched. A mismatch is reported to the owner at once and recorded on the security ledger.

## Rollout and maturation

- **Test-agent rung:** a throwaway agent pairs a scripted phone with a presence key in the pairing request (confirmed on approval), registers one the old way (unconfirmed), runs the fingerprint check (match and mismatch).
- **Development-agent rung:** Echo runs it from merge; Justin's phone is offered the fingerprint check once the updated app ships.
- **Fleet:** ships on by default; it changes nothing for existing checks, so it needs no graduation gate. The later console-ticket step is separate.

## Rollback

Revert. The optional fields are ignored by older code.

## Tests

- Unit: pairing request with a presence key is confirmed by each approval channel; without one, registration after pairing is unconfirmed; fingerprint computation matches between server and a test vector; dashboard confirm requires the PIN and a matching fingerprint; mismatch path offers re-pairing and records the event.
- Integration: the real pairing flow with a P-256 presence key in the request.

## Open questions

1. Android: where the app's source lives, and whether `PresenceKey.kt` is wired into registration (asked of the Chief of Staff 11:43Z).
2. Linux and Windows apps: which exist, and how they store their device keys (asked 11:43Z).
3. App half (echo-instar-apple-app-rebuild): send the presence key in the pairing request; show the fingerprint and the "Confirm Face ID" screen.
