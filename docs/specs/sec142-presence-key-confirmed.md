---
title: "A phone's Face ID key is bound when the phone is paired, and attestation is the only full fix"
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
# A phone's Face ID key is bound when the phone is paired, and attestation is the only full fix

## Problem statement

An owner's phone holds a second key, the **presence key**, which signs only after Face ID, Touch ID or the phone's passcode. The agent relies on it for every Face ID check: opening the console without the PIN (which hands the phone the agent's access token), unlocking the desktop, revealing the PIN, approving sensitive actions, closing or moving sessions, and soon the typing go-ahead (SEC-140).

The first presence key a phone registers on a machine is accepted with only the phone's device key and proof that the caller holds the new key (`POST /mobile/device/presence-key`, `src/server/mobileConsoleTicket.ts`). Any key passes that proof, including one made in software; once set, it cannot be replaced without pairing again or the local override (`replacePresenceKey`, app-trust-approval §D).

## Who can exploit it, and what that means

- **On the iPhone only the app itself can use its keys:** the device key lives in the Secure Enclave behind the app's keychain access. So the only attacker who can register a key first is harmful software running as the app, before the genuine code registers on that machine.
- **That attacker defeats every check this spec could add on the server.** It draws the app's screens, so any comparison shown in the app (a fingerprint, a code) shows what it wants. It can reveal the PIN through PIN reveal with its own key, and so pass any PIN-confirmed step. It can wait for the real owner's Face ID and use the result. The sign-in design accepted exactly this attacker, because it could equally read a PIN typed into the same app (mobile-console-device-signin, Security).
- **Android:** the device key is in the Android keystore and cannot be exported (Chief of Staff); the same reasoning applies once the app registers presence keys. Whether `PresenceKey.kt` is wired into registration is not verifiable from this machine (Open questions).
- **Computers:** a computer paired at the computer cannot register a presence key today (`activeOwnerPhone` excludes them until piece 3b); the local install has no pairing request to carry one. How the Linux and Windows apps store keys is asked of their owners.

So a server-side "confirmation" cannot tell the genuine key from the attacker's for the only attacker in scope. Earlier drafts proposed a fingerprint comparison; all three reviewers showed the app draws it and a 6-character code can be matched by search, so it is removed.

## What is worth doing without attestation: close the timing gaps

The window is wider than one moment: it is open from pairing until the genuine app registers, and again on every further machine the phone pairs with. Binding the key at pairing closes those gaps for software that arrives after pairing, at no cost to the owner:

1. **The pairing request carries the presence key.** An updated app sends its presence public key and possession proof in the redeem request. The server stores it on the pending record and sets it in the same write that activates the device (`applyConfirm` and the activation path), so there is never an active device without its key or a key without activation. The redeem answer says `presenceKey: 'bound'` so the app knows not to register separately; an older server omits it and the app registers the old way.
2. **Which approvals bind it:** `telegram-dm`, `dashboard-pin`, `owner-phone` and `owner-agent`, the approvals of a phone's own pairing request. Not `at-computer` (those phones cannot hold a presence key yet), not `local-install` (no request), not `person-phone` (linked browsers, never a presence key).
3. **A later registration on an already-paired phone is marked as such** (`presenceRegisteredVia: 'after-pairing'`), and listed in the owner's security view; a key bound at pairing shows `'pairing'`. Replacing the key through the local override sets `'local-override'`. This is a label for the owner and for the weekly review, not a trust upgrade.
4. **Ledger and recovery:** the ledger activation row gains the presence key hash, so boot recovery after a crash between the ledger and registry writes restores the key together with the device or neither.

What this does not do: stop harmful software that is already in the app at pairing. It puts its own key in the pairing request, the owner approves the phone they meant to pair, and the key is bound.

## The full fix: platform attestation (a decision for Justin)

Only the platform can prove a key was made in the phone's hardware by the genuine app: Apple's **App Attest** (DeviceCheck) and Android's **key attestation** certificate chain. With attestation at registration, the server accepts a presence key only with proof that the genuine, unmodified app created it in the Secure Enclave or keystore with presence required. That closes the window for in-app software that is not the genuine build (a tampered or repackaged app), though not for a compromise of the genuine app's own code paths, which no key check can detect.

Costs: a dependency on Apple's attestation service (and Google's roots), a second enrolment protocol, per-app setup, and the case of a device or OS that cannot attest. The sign-in design rejected App Attest on cost for its narrower scope; the Face ID key now backs more features (console token, approvals, typing), which may change that balance. **Recommendation:** ship the timing-gap fix now; decide attestation with Justin as its own spec, since it changes the app contract on both platforms.

## Consequence for the typing go-ahead (SEC-140)

The typing go-ahead protects against an unattended unlocked phone and a stolen or replayed device signature, which do not depend on how the presence key was registered. It does not protect against harmful software running as the app, which can wait for the owner's Face ID; neither can any other check here. So SEC-140 does not need this spec to be useful, and `require` should not be described as defeating in-app compromise. SEC-140's registration states become `bound-at-pairing`, `after-pairing`, `local-override` or `none`, shown to the owner; none of them is treated as proof against in-app compromise.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A presence key in a pairing request is set with the activation that approves it | invariant | basis: enumerable-domain; evidence: the approval channels for a phone's own request are listed above; storing key and activation in one write keeps them consistent. |
| No server-side "confirmation" of an existing key | invariant | basis: external-constraint; evidence: the only attacker able to register first is the app itself, which controls every in-app comparison and can obtain the PIN; a confirmation would mark its key trusted. |
| Attestation | judgment-candidate | floor: none shipped until decided; arbiter: Justin, with a separate spec; fallback: timing-gap fix only. |

## Multi-machine posture

Presence keys and their `presenceRegisteredVia` labels live on each machine's device record, as presence keys do today (a phone registers per machine). machine-local-justification: physical-credential-locality (the registration is per machine; the label describes that registration). The weekly review reads them per machine through the existing signed pool read of device summaries, which the build names in the review step.

## Migration

- Device records gain optional `presenceRegisteredVia` (absent = registered before this change, shown as "registered before tracking").
- The redeem request gains optional `presenceKey`, `presenceProof`; the answer gains `presenceKey: 'bound'`.
- The ledger activation row gains an optional presence-key hash.

## Tests

- Unit: redeem with a presence key binds it on each listed approval and not on the others; one write activates and binds; a crash between ledger and registry restores both or neither; the old registration route still works and labels `after-pairing`; the local override labels `local-override`; the redeem answer reports `bound`.
- Integration: the real pairing flow with a P-256 presence key in the request.

## Rollback

Revert; the optional fields are ignored by older code.

## Tracked follow-through

Each piece outside this spec has an owner and a date, recorded as tracked commitments when this spec is approved:
- **App half** (send the presence key in the pairing request, honour `presenceKey: 'bound'`): owner echo-instar-apple-app-rebuild, handed over with the approved spec; checked when the app build lands, within two weeks of approval.
- **Attestation decision:** owner the Chief of Staff, in the consolidated phone-security ask to Justin; if yes, Echo writes the attestation spec within a week of his answer.
- **Android and desktop key facts:** owner the Chief of Staff (asked 2026-11-21 11:43Z); Echo updates this spec within a day of the answer.

## Open questions

1. For Justin: platform attestation (App Attest, Android key attestation) as its own spec, yes or no.
2. Android: where the app's source lives and whether `PresenceKey.kt` is wired into registration.
3. Linux and Windows apps: which exist and how they store keys.
4. App half (echo-instar-apple-app-rebuild): send the presence key in the pairing request and honour `presenceKey: 'bound'`.
