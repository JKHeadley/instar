---
title: "Face ID keys are bound at pairing, and software-keyed devices never hold owner authority"
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
# Face ID keys are bound at pairing, and software-keyed devices never hold owner authority

## Problem statement

An owner's phone holds a second key, the **presence key**, which signs only after Face ID, Touch ID or the phone's passcode. The agent relies on it for every Face ID check: opening the console without the PIN (which hands the phone the agent's access token), unlocking the desktop, revealing the PIN, approving sensitive actions, closing or moving sessions, and soon the typing go-ahead (SEC-140).

The first presence key a phone registers on a machine is accepted with only the phone's device key and proof that the caller holds the new key (`POST /mobile/device/presence-key`, `src/server/mobileConsoleTicket.ts`). Any key passes that proof, including one made in software; once set, it cannot be replaced without pairing again or the local override (`replacePresenceKey`, app-trust-approval §D).

## The devices, as they are today

From the Chief of Staff's reading of the app source (private repository EchoOfDawn/instar-desktop-apps; message 35137544-aea4-4dde-996a-aeeec7bf13c5, 2026-11-21 11:45Z), in their words:
- **Android:** "Device key: EC key in AndroidKeyStore, non-exportable, StrongBox when present. No attestation or isInsideSecureHardware check." "PresenceKey IS wired in" (callers: OwnerApproval, ConsoleSignIn, RemoteDesktop, WorkBoardTaps, ProjectTaps, CardCreateFlow, ApproverScreen, PinScreen). "It enrols on demand: OwnerApproval.ensureEnrolled, and flows retry on 409 presence-key-missing. So Android has the same first-come window as iPhone, and your fix must keep that first-use flow working."
- **Windows:** "device key in the TPM through the Microsoft Platform Crypto Provider, non-exportable. Release builds cannot use a software key."
- **Linux:** "P-256 software key, exported as PKCS#8 into the desktop password store (Secret Service). Any program under that login can copy it." The app labels itself software-keyed, but the server does not receive or enforce that today (checked: nothing in the pairing or device code reads a key-storage field).
- **iPhone:** device and presence keys in the Secure Enclave; only the app can use them.
- The device registry records neither platform nor key storage.

## Who can exploit first-come registration

- **Copied-key attacker (real today, on Linux).** Any program running under the Linux user's login can copy the device key. A Linux PC paired as an owner device passes `activeOwnerPhone` (it is not admitted at the computer, and the check does not look at storage), so a copied key can register a software "presence" key and then pass every Face ID check: the console ticket (the agent's access token), approvals, PIN reveal and, with SEC-140, typing. This is the most concrete exposure and is closed by the software-key rule below, not by binding or attestation.
- **Code running as the app, before registration (iPhone, Android, Windows).** On these platforms only the app can use its hardware keys, so only code running as the app can register first. Such code already holds everything the app can do on that device: it draws the screens, can reveal the PIN with its own key, and can wait for the owner's real Face ID. A server-side confirmation cannot tell its key from the genuine one, so this spec treats it as an accepted limit (see Attestation and the accepted limit).

## What is worth doing without attestation: close the timing gaps

The window is wider than one moment: it is open from pairing until the genuine app registers, and again on every further machine the phone pairs with. Binding the key at pairing closes those gaps for software that arrives after pairing, with no extra step for the owner. A phone that cannot create a presence key (no passcode set) or where the person cancels Face ID during setup still pairs, without a key; Android's on-demand enrolment (`OwnerApproval.ensureEnrolled`, retrying on `409 presence-key-missing`) keeps working through the existing route for such phones and for apps not yet updated; the activation shows "Face ID isn't set up for this phone yet", the PIN paths keep working, and the app can register the key later through the existing route (labelled `after-pairing`). A presence proof that is present but invalid gets an explicit error (`presence-proof-invalid`) and the pairing request is refused, so nothing is half-bound:

1. **The pairing request carries the presence key.** An updated app sends its presence public key and a possession proof in the redeem request. The proof signs `instar-presence-enroll-v2\n<sha256 of the device public key>\n<host>\n<sha256 of the pairing code>\n<presence public key>`, so it is tied to this pairing and this device key (both known before redeem). The server refuses the field when the presence key equals the device key or is already the device or presence key of any other device record (the check `replacePresenceKey` already makes, now applied to every binding path including `setPresenceKey`), and accepts it only for a request that would make an owner phone (role `owner`, not `msp` or `team`, not a computer), whatever the approval channel.
   - The **full** presence public key is stored on the pending record and set in the same write that activates the device (`applyConfirm` and the activation path).
   - The redeem answer says `presenceKey: 'accepted'` (stored with the pending request, not yet bound). The app learns it is bound from the pairing status once activation commits (`presenceKey: 'bound'`); only then does it skip separate registration. If activation never happens, nothing is bound. An older server omits the field and the app registers the old way.
2. **Which approvals bind it:** `telegram-dm`, `dashboard-pin`, `owner-phone` and `owner-agent`, the approvals of a phone's own pairing request. Not `at-computer` (those phones cannot hold a presence key yet), not `local-install` (no request), not `person-phone` (linked browsers, never a presence key).
3. **Each registration is labelled for the owner:** `pairing` (bound at pairing), `after-pairing` (the old route on an already-paired phone), `local-override` (replaced through the local override), and, for keys that existed before this change, `before-tracking`. A same-key re-registration (already idempotent) keeps the existing label, so a retry never rewrites history. The label is for the owner and the weekly review, not a trust upgrade.
4. **Ledger and recovery:** the full presence public key goes in its own signed row type, `presence-binding` `{type, keyHash, deviceId, presencePublicKey, registeredVia, boundAt, machineId, signerKeyHash, sig}`, with the registration label signed together with the key, written with the activation row, not as a new field on it. Every path that sets a key writes one: pairing (`pairing`), the old route after pairing (`after-pairing`), the local override (`local-override`). The registry and the latest binding row are written in one procedure (binding row first, registry second, as the ledger already orders activations), and boot recovery completes an interrupted one. Older machines rebuild an activation row from a fixed field list before checking its signature, so a new field would break every new-flow activation on a machine still on older code; an unknown row type is instead skipped when they read the ledger and reported as invalid on ingest, which is harmless (`MobileDeviceKeyLedger.ts`, read and ingest paths). Boot recovery after a crash between the ledger and registry writes restores the key with the device or neither. Tests: restart between the two writes, then verify a presence signature with the recovered key; an older reader given a new-flow activation plus binding row keeps the activation valid and skips the binding.

What this does not do: stop harmful software that is already in the app at pairing. It puts its own key in the pairing request, the owner approves the phone they meant to pair, and the key is bound.

## Attestation and the accepted limit

Attestation (Apple App Attest, Android key attestation) proves a request comes from a genuine, signed build on a real device. It does **not** prove that build is uncompromised (Chief of Staff, message 71ee1774-ba3a-4652-b714-e3af06236db7: "If the attacker is harmful code inside our own signed app, such as a poisoned dependency or update, attestation passes").

- **Stops:** a repackaged or fake app; a copied key used from another program (on Android, the attestation chain ties the key to the keystore that made it); some rooted or modified devices.
- **Does not stop:** harmful code inside the genuine signed app, which is the code-running-as-the-app attacker above.
- **What it proves on each platform:** on the iPhone an App Attest assertion over the presence public key shows the genuine app endorsed those bytes, not where the private key was made or that it requires Face ID; on Android the key's own attestation chain shows it was made in the keystore and, when the record says so, that each use needs user authentication.
- **What defends against harmful code inside the genuine app:** release signing and protected build pipelines, dependency review and pinning, and limiting what one compromised client can do (short-lived, narrowly scoped grants; owner approval for the highest-impact actions through a second channel). Nothing fully stops it, and it is stated here as an accepted limit.
- **Costs if adopted:** dependence on Apple's attestation service and Google's attestation roots; an extra enrolment protocol on both apps; failure handling when the service is down; devices and OS versions that cannot attest; privacy review of what the attestation reveals.

**Recommendation:** not now. It would add protection against repackaged apps, which is not the attacker that matters most today; the copied Linux key is closed by the software-key rule. Kept as a possible follow-up for the Chief of Staff to weigh.

## Software-keyed devices never hold owner authority on their own

**One rule, one function.** `ownerPresenceAllowed(device)` in `src/server/mobileConsoleTicket.ts`, next to `activeOwnerPhone`, decides whether a device may use owner-presence authority. It is called by every presence-gated surface: presence-key registration, the console ticket, desktop unlock, PIN reveal, owner-action approvals, session controls (`mobilePermissionsRoutes`), the trust-approval port, document decisions (`documentDecisionRoot.ts`), the pairing introducer (`mobilePairingIntroducer.ts`) and the SEC-140 typing grant. Conversations keep using `activeOwnerPhone`, so chat, reading and notices are unaffected (the same shape as today's admitted-at-computer exclusion).

**Key storage, from evidence rather than only the client's word:**
- **New pairings:** the pairing request gains `keyStorage: 'hardware' | 'software'` and `platform`, stored once at pairing and never changed by a later request. This is the client's own report, not proof (attestation is not adopted, see above): it is trustworthy against the attacker this rule targets, a copied key from the genuine Linux app, because the genuine app reports `software` at pairing and the copy inherits that record. A modified client could report `hardware` at its own pairing, which still needs the owner's approval like any pairing; that is the accepted limit. The genuine Linux app sends `software`; iPhone, Android and Windows release builds send `hardware`, each reporting the storage level the generated key actually has (Android: `KeyInfo.getSecurityLevel`; a key that turns out not to be in secure hardware is reported `software`).
- **Existing records with positive evidence of hardware:** a Mac created by the local install (`createActiveLocalOwner`) or paired with a key-bound QR code (mac-qr-pairing) is `hardware`, because the Mac app keeps its keys in the Secure Enclave.
- **Every other existing owner device** is `undetermined`. On upgrade the agent shows the owner one review card listing each such device by name, kind and when it paired, and asks them to mark which are Linux computers (`software`) and which are phones or Windows computers (`hardware`). The agent does the classifying work and the owner only confirms: it pre-fills each row from what it already knows (the device's name and label, its recorded kind, the pairing route, and the client the device's requests identify themselves as, where recorded), so the card reads like "Linux computer 'work-laptop', paired 3 November: mark as a software key? Yes / No". Until a device is marked it keeps today's authority, and the agent re-raises the card weekly and in the security review until none are left. This covers Linux pairings that were stored as phones, which no server signal can identify with certainty.

**The rule:** `ownerPresenceAllowed` is false for `software` devices. They can chat, read and receive notices, but cannot register a presence key, obtain a console ticket or typing grant, approve, reveal the PIN or take any owner-presence action.

**Routes left to the owner of a software-keyed device:** the dashboard PIN for console and approvals; the owner's direct chat for trust approvals and for PIN recovery (the existing PIN-reset route through the owner's direct chat); any hardware-keyed owner device. An owner whose only devices are software-keyed still has the PIN and the direct chat; the review card says so before anything is marked.

**Suspected prior exposure.** Blocking future tickets does not withdraw an access token a copied key may already have obtained: a console ticket hands out the agent's API token, which stays valid until rotated (mobile-console-device-signin, Security). When a device is marked `software`, the agent tells the owner plainly that if the computer's key may have been copied, the access token should be rotated, and what rotation does (every program and device using the old token must re-authenticate; paired phones re-pair the console sign-in, not the whole pairing). It offers the rotation as a one-tap owner decision.

**Rollback:** reverting the server restores today's enrolment and authority behaviour for every device, including `software` ones; the stored fields are ignored.

## Phones paired before this change with no presence key

They keep the first-come window until bound. Until then: in SEC-140 `accept` they behave as today; a key registered after the upgrade through the old route is labelled `after-pairing`, and under SEC-140 `require` an `after-pairing` key registered after the upgrade is not enough for a typing grant (blocked, with the fix in the message). The agent offers each such phone a one-tap re-pair with the updated app, which binds the key at pairing. Keys registered before the upgrade (`before-tracking`) count as today, because the window had to be exploited before this change to matter and cannot be distinguished now.

## Consequence for the typing go-ahead (SEC-140)

The typing go-ahead protects against an unattended unlocked phone and a stolen or replayed device signature, which do not depend on how the presence key was registered. It does not protect against harmful software running as the app, which can wait for the owner's Face ID; neither can any other check here. So SEC-140 does not need this spec to be useful, and `require` should not be described as defeating in-app compromise. SEC-140's registration labels are `pairing`, `after-pairing`, `local-override`, `before-tracking` or `none`, shown to the owner; none of them is treated as proof against in-app compromise.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| A presence key in a pairing request is set with the activation that approves it | invariant | basis: enumerable-domain; evidence: the approval channels for a phone's own request are listed above; storing key and activation in one write keeps them consistent. |
| No server-side "confirmation" of an existing key | invariant | basis: external-constraint; evidence: the only attacker able to register first is the app itself, which controls every in-app comparison and can obtain the PIN; a confirmation would mark its key trusted. |
| Attestation | judgment-candidate | floor: none shipped now; arbiter: the Chief of Staff, who decides whether it goes to Justin; fallback: timing-gap fix and software-key rule only. |
| A `software` or `unknown` computer gets no owner-presence authority | invariant | basis: irreversible-consequence; evidence: a copyable key behind owner authority hands the agent's access token to any program under that login; the dashboard PIN remains for the owner at that computer. |

## Multi-machine posture

- **Unified history.** The binding row (`presence-binding`, public key, device key hash, the machine that approved it, when) is in the signed device-key ledger, which replicates. Every machine can see which key was bound for a phone and where; only the private key stays on the phone.
- **Machine-local use.** A presence key is still accepted on a machine only from that machine's device record, since a phone registers per machine; the shared history lets the weekly review show the owner every phone's registration on every machine from one place.

## Agreement between the ledger and the registry

Every use of a presence key checks that the device record's key and label match the latest verified `presence-binding` row for that device on this machine, where one exists; the label used for any decision is the one in the signed row, so losing or editing the registry's copy cannot change authorization. Keys that existed before this change get `before-tracking` through an explicit one-time migration that writes their binding rows, not by reading a missing label. A mismatch refuses the Face ID action, reports a degradation and appears in the owner's security view, instead of waiting for the next boot.

## Migration

- Device records gain `presenceRegisteredVia`, `keyStorage` and `platform`. A one-time migration writes a `before-tracking` binding row for every existing presence key and classifies existing records as `hardware` (Mac local install or key-bound QR) or `undetermined`.
- The redeem request gains optional `presenceKey`, `presenceProof`; the redeem answer gains `presenceKey: 'accepted'`, and the pairing status answer gains `presenceKey: 'bound'` once activation commits.
- The ledger gains a `presence-binding` row type (older machines skip it).

## Tests

- Unit: losing the registry's label cannot turn a refused grant into an allowed one; a local override writes its binding row and the next Face ID action succeeds, including after an interruption between the two writes; a Mac local-install record is `hardware`; an undetermined device keeps authority until marked; a `software` device is refused every owner-presence surface listed above and keeps chat.
- Unit: redeem with a presence key binds it on each listed approval and not on the others; one write activates and binds; a crash between ledger and registry restores both or neither; the old registration route still works and labels `after-pairing`; the local override labels `local-override`; the redeem answer reports `accepted`, the status reports `bound` only after activation; a redeem that is never approved binds nothing; a lost status answer followed by a retry reports the same state.
- Integration: the real pairing flow with a P-256 presence key in the request; a `software` computer refused a presence key and a console ticket; Android-style on-demand registration after pairing still works.
- Live user-role proof (before the owner is asked to try it): on a throwaway agent, the shipped phone app pairs with the updated server, the status reports `bound`, and a Face ID action (console sign-in) succeeds; a Linux test client pairs as `software` and is refused the console ticket.

## Rollback

Revert; the optional fields are ignored by older code.

## Tracked follow-through

Each piece outside this spec has an owner and a date, recorded as tracked commitments when this spec is approved:
- **App half** (send the presence key in the pairing request, honour `presenceKey: 'bound'`): owner echo-instar-apple-app-rebuild, handed over with the approved spec; checked when the app build lands, within two weeks of approval.
- **Attestation:** not recommended now; the Chief of Staff decides whether it reaches Justin. If it does and he says yes, Echo writes its spec within a week.
- **Software-key rule in the apps:** the Linux app sends `keyStorage: software` and the other apps `hardware` in the pairing request; owner of the desktop apps (via the Chief of Staff), checked when their next build lands.

## Open questions

1. Platform attestation: not recommended now (Attestation and the accepted limit); for the Chief of Staff to weigh.
2. Answered by the Chief of Staff (message 35137544): Android presence keys are wired in; Windows is TPM-only in release; Linux keys are software.
4. App half (echo-instar-apple-app-rebuild): send the presence key in the pairing request and honour `presenceKey: 'bound'`.
