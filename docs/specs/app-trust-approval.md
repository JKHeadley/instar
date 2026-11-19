---
title: "Approving a trust raise from the Instar app"
slug: app-trust-approval
status: approved
author: echo
parent-principle: "Trust Is Earned by Work and Granted Only by the Person"
eli16-overview: app-trust-approval.eli16.md
review-convergence: "2026-11-17T07:52:00Z"
review-iterations: 6
approved: true
approved-by: "justin: the constitution text this implements, topic 143810 2026-11-16 22:13 PST (\"approved\", telegram 143810/144056); the build under his autonomous brief for topic 143810, approved 2026-11-16 13:12 PST in topic 141385"
---

# Approving a trust raise from the Instar app

## Why

A person who has only the Instar app can't give their agent more than "Ask me first" today. The trust journey's account path (`docs/specs/trust-journey.md` decision 5, `src/core/trustJourney/AccountPathService.ts`) sends the approval card to the person's Telegram or Slack direct chat and counts only a reply there. With no owner chat it answers `no-approver`.

Justin, topic 143810, 2026-11-16 20:35 PST: "we definitely do NOT want to require Slack or Telegram if at all possible. We should definitely support Instar app only as the primary route." He approved the constitution text at 22:13 PST. In the 2.0 book, the safeguards rule gains a paired-device exception (instar-2 #205). In the 1.x book, *Trust Is Earned* gains the matching paragraph (instar #3296).

This spec builds that route. It changes nothing for people who use Telegram or Slack.

## What the person sees

1. The agent offers a raise ("I'd like to send reminders without asking each time; here is the record"). The Instar app shows a card: the exact change, the record behind it, what it covers and what it excludes, and that it covers future acts.
2. The person taps **Approve**. The device asks for Face ID or Touch ID (or the iPhone's passcode; a Mac needs Touch ID). On success the raise applies, and the card says so.
3. **The acceptance comes before any request.** When the Mac app creates the agent, the last setup screen asks once: "Let this Mac approve changes to what Scout may do?" It shows the disclosure, and its Yes is the recorded acceptance. That is the moment the constitution text names ("the acceptance is recorded in the app at that moment").
   - A person who skipped it, or whose agent was made another way, finds the same sheet under **Changes to approve** (iPhone: Permissions; Mac: the agent's window).
   - If the agent proposes a raise with no chat and no acceptance, `propose` still answers `no-approver`, and the agent tells the person: "Turn on approvals in the Instar app ("Changes to approve" in the app), then I'll ask again."
   - The person can withdraw the acceptance at any time from "Changes to approve".

## Decisions

### A. A paired-device acceptance, recorded and withdrawable

- **Record:** a `DeviceAcceptanceRecord` (`acceptanceId`, `principal`, `deviceId`, device key fingerprint, `acceptedAt`, `withdrawnAt?`). It lives in the same `TrustJourneyStore`, so it replicates the same way as `AcceptanceRecord` and lands in the same journal.
- **Who records it:** only the device itself, by a presence-signed request, `POST /mobile/trust/device-acceptance`. That request carries the disclosure text the app showed, and its hash is stored.
  - The first device's acceptance is allowed only for a device paired through the app on the agent's own computer:
    - either the Mac itself (`approvedVia: 'local-install'`, with a `localBinding`) when it has Touch ID;
    - or, on a Mac without Touch ID, the iPhone the Mac app pairs during creation. The pairing is approved through the Mac app's local binding, the same way, and its device record carries `approvedVia: 'local-install'` and the pairing Mac's `localBinding`.

    This is the first pairing the constitution text allows ("paired by the Instar app that creates the agent on that computer"). While any device acceptance is current, no other device can take a first acceptance, and every new device needs the `accept-device` approval. If every acceptance has been withdrawn (all devices lost), a new local first pairing with a new recorded acceptance is allowed, as the constitution text says.
  - A later device's acceptance needs a presence-signed approval from an already-accepted device. It uses the same single-use challenge as every other device action, with a new action kind: `accept-device {target: newDeviceId, keyFingerprint, disclosureHash}`. Its expiry is the challenge's own.
    - The signature covers the host, the new device's id, its key fingerprint and the hash of the disclosure it will show.
    - When the new device then records its acceptance, the server checks four things: the approving challenge was consumed for exactly that id, fingerprint and disclosure hash; the approving device's own acceptance is current at that moment; the new device is paired with that key; and the approval is unexpired.
    - A replayed challenge fails because it is single-use.
  - The bearer token and the dashboard PIN can never record one.
- **Withdrawal:** `POST /mobile/trust/device-acceptance/withdraw` from the device, or the existing `POST /trust/acceptance/withdraw`. Both write `withdrawnAt`.
- **Who decides:** the device path runs where the chat path already runs: on the serving-lease holder (`AccountPathService` header, trust-journey decisions 5 and 13). Acceptance, withdrawal and approval reach it the same way chat receipts do. This spec adds no new authority, handoff or fencing. Whatever single-holder guarantee the serving lease gives the chat path, the device path gets exactly the same, and no more. A machine that isn't the holder refuses device approvals with "try again in a moment" instead of deciding.

### B. Approving a widening request from a device

- **Where it is listed:** `GET /mobile/trust/requests` returns the open `RequestRecord`s with their proposal text, for the app's card. It also returns requests consumed in the last 7 days, each with a status read from the store:
  - `applied` or `not-applied` when an outcome record exists;
  - `unknown` when a consumption exists with no outcome;
  - `expired` or `declined` from the request's status.

  A restarted app therefore shows the same result the card showed. A test reopens the listing after consumption, both with and without an outcome record.
- **The challenge:** `POST /mobile/permissions/challenge` gains a new action kind, `approve-widening {target: requestId, proposalHash}`. It uses the same single-use challenge, bound to device, host and the exact action line.
- **The approval:** `POST /mobile/trust/requests/:id/approve` goes through the existing `writeGate` + `proven` path (owner device, local TLS or local binding, presence signature).
  - **Using up the challenge:** `proven` alone does that, as it does today.
  - **What the service receives:** a verified authorization `{ deviceId, keyFingerprint, host, requestId, proposalHash, challengeId }`. It never sees or consumes the challenge itself.
  - **Not the holder:** a machine that isn't the serving-lease holder refuses before issuing a challenge. No machine forwards approvals or trusts another machine's verification.
  - **What `AccountPathService.onPresenceApproval(authorization)` checks, on the deciding machine:**
    1. the request is open, unexpired and its proposalHash matches;
    2. a current `DeviceAcceptanceRecord` exists for this device, not withdrawn, and its key fingerprint equals the authorization's;
    3. the device is still paired and active, with that same key.

  An acceptance belongs to one key. Re-pairing a device, or replacing its key under the same deviceId, withdraws the acceptance automatically.

  **One operation owns consumption:** the existing `consume`. Its first durable step writes the consumption record under the key `tj:consumption:<requestId>`. Store records are immutable, and a key is reserved before the durable wait (`TrustJourneyStore.write`), so a second write of that key fails. That write is the compare-and-set: a chat approval and a device approval arriving together produce exactly one consumption, and the loser gets "already approved". Issuing the proof and applying the change are later steps of the same `consume`, never a second consumption. A test covers the race, not just sequential retries.

  - **If the process stops between consumption and the outcome:** the raise is never applied twice, and its state is never guessed.
    - An outcome record (`applied` or `not-applied`, keyed by requestId) is written after the apply returns.
    - A consumption with no outcome stays `unknown`: no reconciliation, no retry. The card and the agent both say "Your approval was recorded, but Instar can't confirm the change took effect. Check the setting, and ask again if it isn't there."
    - A test stops the process between consumption and outcome, and checks that it shows `unknown`.

  It then calls the same `consume` the chat path uses, with a new proof kind, `'accepted-device'`, from `TrustRaiseGuard.issueOperatorProofFromConsumedReceipt`. `proofCovers` accepts it alongside `'accepted-account'`.
- **Recording:** the consumption record notes `kind: 'accepted-device'`, the deviceId and the acceptanceId. Every place that displays or exports it carries the disclosure: "Approved on Justin's Mac. The list of paired devices is kept on the agent's own computer, so this is not independently verified."
- **When there's no chat:** `propose` no longer answers `no-approver` when a device acceptance exists. It records the request with `adapter: 'device'`, and sends the app a push notice ("Scout is asking to send reminders without asking. Open Instar to decide.") instead of a chat card. When both a chat and an accepted device exist, both can approve, and the first to arrive consumes the request.

### C. The agent can't approve its own raise

- The device key is a Secure Enclave key (`InstarApp/PresenceKey.swift`). On a Mac it uses `.biometryCurrentSet`, and a Mac without Touch ID gets no key (D). On an iPhone it uses `.userPresence`. The agent can't extract that key or sign with it. That protects the app's key only; it doesn't prove that an approval came from the person, because the agent could add a key of its own (below, and the local override in D).
- The agent could add a device record whose key it holds. The constitution text names this as the limit and requires the disclosure. This spec adds what can be checked:
  - the acceptance needs a presence signature from the device itself;
  - a new device's acceptance needs approval from an already-accepted device;
  - every new pairing and acceptance is shown on every accepted device (a notice through the existing push path).
- **Later, separate work:** hardware attestation (Apple App Attest) would let the server check that a key belongs to a genuine Instar app on a genuine device, so the agent couldn't add a look-alike key of its own. It would not protect the acceptance records or the grants themselves from being edited on the agent's computer; that is a separate limit. It is out of this spec, and named in its limits.

### D. Mac app

- **Mac target:** add `ActionApprovalViews` (or a Mac equivalent) and a "Changes Scout is asking for" card to the Mac target. The data layer (`PermissionsData.swift`, `PermissionActionFlow.swift`, `PresenceKey.swift`) is already compiled for macOS.
- **Macs without Touch ID:** no approval key, as today. `PresenceKey.swift` already refuses to create one on such a Mac, with this reasoning: the agent may run on this Mac with full control of it, so only a finger approves there. A password the agent might know is not the person's presence.
  - On such a Mac, the "Changes Scout is asking for" card says: "Approve this on your iPhone (Instar app), or on a Mac with Touch ID."
  - The iPhone app (`.userPresence`: Face ID, Touch ID or the phone's passcode) is the approving device. The phone's passcode is entered on the phone, which the agent doesn't control.
  - The key's access policy is stored with the acceptance, and the disclosure names it ("approved with Touch ID", "approved with Face ID or the iPhone's passcode").
  - A `.biometryCurrentSet` key is invalidated when fingerprints change; the local override below replaces it.
- **Replacing this Mac's key, locally:** this is an explicit local override, available whether or not other devices exist. It is the same thing as the first pairing, done again: the app on the agent's own computer (loopback, a device record with a `localBinding` to this machine) makes a new `.biometryCurrentSet` key and records a new acceptance. The ceremony asks for Touch ID before the request is sent. A Mac without Touch ID can't use the override and has no approval key, as above. The constitution text already covers it ("a new first pairing needs a new recorded acceptance").
  - The server revokes the old key and withdraws its acceptance in the same step.
  - It records `via: local-override` and shows "approval key replaced on this Mac" on every other accepted device and in the trust record.
  - The server can't tell this request from one the agent makes with its own key, the same limit as the first pairing, so it is a duty with visible checks, not a verified one. A remote device can never use it.
- **The one-time acceptance sheet:** it shows the disclosure, and its Yes makes the acceptance request.

## Acceptance

1. **Unit:**
   - **Route and verifier layer:** a replayed challenge is refused, and a machine that isn't the serving-lease holder refuses a device approval.
   - **Service and store layer:** `onPresenceApproval` refuses an expired request, a wrong hash, no acceptance, a withdrawn acceptance, a revoked device, and a key fingerprint that doesn't match the acceptance (key replaced under the same deviceId). It accepts once, and the proof kind is `accepted-device`. Two concurrent consumptions of one request produce exactly one raise.
   - **Local override:** replacing the key revokes the old one, withdraws its acceptance and records the new one, with or without other devices. A remote device attempting it is refused.
2. **Integration:** on a real `AgentServer`, starting with no chat and no acceptance, a proposal answers `no-approver`. After the device records its acceptance, the same proposal succeeds and is listed for the device. A presence-signed approval applies the raise. A second approval of the same request is refused.
3. **E2E:** the routes are alive on the production boot path.
4. **Live:** on a throwaway agent created by the Mac app, the agent offers a raise, the Mac shows the card, Touch ID approves, and the setting changes. On a Mac without Touch ID (the Mac Studio), the card points to the iPhone instead, and the same request is approved from the iPhone app. Withdrawing the acceptance makes the next approval fail with a plain message.
5. **Races:** a chat approval and a device approval of the same request at the same time produce one raise.

## Limits

- **Device keys:** the device list is kept on the agent's own computer, so this is a duty, not an independently verified guarantee. The disclosure says so. Attestation would later make device keys verifiable.
- **Saved records:** acceptance records, consumption records and grants are also kept on the agent's own computer. Attestation would not change that. Running the server under a separate account would.
- Running the server under a separate account from the agent would close the same class (filed: fb-f4434d42-301).

## Depends on

instar #3236 (trust journey stage 0, parts B and C, adopted by this run) and the constitution pair instar #3296 / instar-2 #205.

## Convergence

Six cross-model rounds (codex-cli) found 3, 4, 3, 3, 4 and 3 issues. After round 5 the spec was cut back to the guarantees the chat path already has:
- no forwarding between machines (only the serving-lease holder decides);
- no reconciliation by reading the setting (`unknown` stays `unknown`);
- key replacement is the local override, the same as the first pairing.

Round 6 found only missing protocol detail, and that is written in above. The round cap is reached; the build follows this text.

After round 6, the build found that `PresenceKey.swift` deliberately refuses a password-only key on a Mac (the agent may control that Mac). The spec now keeps that rule instead of round 1's `.userPresence` fallback: a Mac without Touch ID points the person to the iPhone app. That narrows the design; it adds no new mechanism.
