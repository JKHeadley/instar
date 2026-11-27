---
title: "Add a new agent from a phone you already use: one Face ID approval, and a wait screen that only shows ways that work"
slug: "mobile-pairing-introducer"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mobile-pairing-introducer.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under its standing grant that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); applied by the builder session per Echo's brief for topic 134088, 2026-11-06"
review-convergence: "2026-11-06T19:16:22.375Z"
review-iterations: 5
review-completed-at: "2026-11-06T19:16:22.375Z"
review-report: "docs/specs/reports/mobile-pairing-introducer-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem

On 2026-11-06 (topic 134088) Justin paired his iPhone with a brand-new agent, "pairtest", that Echo had set up on a cloud machine. The phone's wait screen said "Tap Approve on Pairtest's dashboard, on its Phones page". That dashboard asks for a PIN Justin never had (Echo created the agent). So Echo told him in chat to send it the key and approved it over SSH. His words (10:48): "This is still very confusing. It's telling me to tap something to approve. But you're telling me to tell you, yes. This whole process should be extremely straightforward and dummy proof."

His earlier decision (2026-11-02 18:16, topic 136110, recorded in Echo's `.instar/vm-test/README.md`, "Pairing redesign"): one safety step, never two look-alike numbers, never a dashboard PIN in the path; a QR when the machine has a screen; one short code when phone-only; and for an already-paired phone adding an agent made by one of the user's agents, an in-app "Add <agent>? Approve" (he liked it and wants a code or QR step kept).

Three defects, one goal (one obvious step):

1. A phone already paired as the owner's phone with one of the user's agents cannot vouch for itself to a new agent. The new agent has never seen that phone (the app makes a new Secure Enclave key per agent), so the only ways in are a Telegram chat or a dashboard PIN.
2. The wait screen names a dashboard Approve button even when nobody has that dashboard open and the user may not have its PIN.
3. Feedback `fb-cceb7986-efa`: on an agent with no Telegram and native app conversations off (every customer agent: native is dev-gated), `approvalPath()` answers `telegram` because `ownerDM` is always wired. The link mints, and the phone can never be confirmed.

## 2. What exists (instar main 3d5617b21)

- **Pending phones** (`DeviceRegistry`, machine-local): `pending`, `expiresAt`, key `fingerprint` (first 16 hex of SHA-256 of the device public key, `XXXX-XXXX-XXXX-XXXX`). `GET /mobile/device` is signed by the pending phone and allowed while pending.
- **One approval funnel** `approvePending(deviceId, via, {approvedBy})` (mobile-pairing-approve §3.1): refuses `ended`, MSP (`code-only`), `contested`, `paused`, `moved` (Telegram path off the lease holder), `another-phone-waiting`; writes the key-ledger row first, then the registry.
- **Same-agent owner phone approve** (#2813, CMT-1353, `mobilePairingApproval.ts`): an active owner phone of THIS agent, over local TLS, gets a single-use challenge (`BoundSecretStore`, 60 s) bound to the approver, the Host and the exact line `approve <deviceId> <fingerprint>`, and signs `instar-pairing-approve-v1\n…` with its **presence key** (a second Secure Enclave key that signs only after Face ID or the passcode; `verifyPresenceSignature`). Only phones of the same agent and the same machine can do this; the earlier spec says "Signed cross-agent or cross-machine trust is deliberately not built" (mobile-pairing-approve §6).
- **Agent identity** (`identity.json`, Ed25519): ONE key per agent across all its machines (a joining machine adopts it, agent-identity continuity). `IdentityManager(stateDir).get()` returns `{publicKey, privateKey}` (raw 32 bytes); `sign`/`verify` in `ThreadlineCrypto`.
- **Operator binding / Know Your Principal**: authority comes from an authenticated channel, never from a name in content. Nothing today tells a new agent who its owner's other agents are.
- **Dashboard operator sessions** (`DashboardOperatorSessionStore`, memory, 15 min): proof that someone passed the PIN recently. The pairing page (`/dashboard/pair`) shows the code and Approve only inside such a session.
- **Wait screen** (app `PairingApproveViews.swift`): one line per entry of `confirmWith` (`telegram`, `dashboard`, `owner-phone`), the phone's key, "Use a code instead".
- **The identity key is not a safe signer for new statements.** `RelayClient.handleChallenge` signs the relay's auth nonce as-is with the identity key (no domain prefix), so whoever controls the relay connection can get arbitrary bytes signed by it (filed as `fb-0b697128-30f`). Anything new that an identity-key signature would prove must use a different key.

## 3. Design

This reverses one line of mobile-pairing-approve §6 ("Signed cross-agent or cross-machine trust is deliberately not built"): this spec builds exactly that, for one narrow statement. The sibling spec gets a pointer to this one.

### 3.1 The trust anchor: an introducer the new agent is told about at creation

**The introducer key.** Each agent has an **introducer key**: an Ed25519 key derived from its identity seed, `seed = HKDF-SHA256(identitySeed, salt = empty, info = "instar-owner-introducer-key-v1", 32 bytes)`. It is never stored and never the identity key itself, so the relay's raw-nonce signing (§2) cannot produce an introducer signature. Every machine of the agent derives the same key, because every machine holds the same adopted identity. An identity rotation changes it (§4).

**The trust list.** A new agent learns who may vouch for its owner's phones from its **creator**, never from a request. Config on the new agent:

```json
"mobilePairing": { "ownerIntroducers": [ { "name": "Echo", "publicKey": "<base64url raw Ed25519 introducer key, 32 bytes>" } ] }
```

- At most 8 entries. An entry with a malformed key or no name is skipped and reported once (DegradationReporter).
- Read from the running config. The creator writes it before the new agent's first start; a change to a running agent takes effect at its next restart. This is the documented contract, and the CLI says so.
- Whoever can write this file already controls the agent completely (its auth token, PIN and device registry live beside it), so adding an entry grants nothing that writer did not already have. `mobilePairing` is not a key the config PATCH route accepts (`PATCHABLE_CONFIG_KEYS`), so **no HTTP route can add an introducer** and an API-token holder cannot plant a key it holds. A test pins that refusal.

**The creator's step is a command, not a remembered instruction.**

- `instar mobile introducer show [--json]` on the introducer prints its entry (derived from its identity on disk).
- `instar mobile introducer add --name <n> --key <k>` on the new agent writes the entry (atomic write, file mode kept). `remove --key` and `list` complete the set.
- `GET /mobile/introducer` (bearer, or an active owner phone of that agent) returns `{ name, publicKey, keyId, configEntry }`, the same entry, for an agent creating another one over its own API. `keyId` is the first 16 hex of SHA-256 of the key, upper case, in four groups. It answers 404 `no-identity` when the agent has no identity yet.
- The CLAUDE.md awareness text tells an agent that creates an agent for its owner to run `show`, then `add` on the new agent, then (re)start it.
- Retrofitting an existing agent (pairtest): the same `add`, then a restart. A restart expires pending pairings only; paired phones stay paired.

### 3.2 The introduction: the introducer signs for one exact waiting phone after the owner's Face ID

On the introducer (agent A), two device-signed routes, owner phones only, with the same gate as #2813: the feature is on, a device principal, local TLS, `activeOwnerPhone`. Allowlist rows: `POST /mobile/introductions(/challenge)?`, statuses `active`, `ownerOnly`, body `json`, the shared 12/min `pairing-approve` bucket. `GET /mobile/introducer`: `active`, `ownerOnly`, its own 30/min bucket.

- `POST /mobile/introductions/challenge` with `{ audienceHost, deviceId, fingerprint }` → `{ challenge, expiresAt }`.
  - Validated: `audienceHost` lower-case `[a-z0-9.-]{1,253}(:\d{1,5})?`; `deviceId` a lower-case UUID; `fingerprint` `^[0-9A-F]{4}(-[0-9A-F]{4}){3}$`.
  - The challenge (60 s, single use) is bound to the approver, A's signed Host, and the line `introduce <audienceHost> <deviceId> <fingerprint>`.
  - 409 `presence-key-missing` when the phone has no presence key; the app enrols one, as in #2813.
- `POST /mobile/introductions` with `{ audienceHost, deviceId, fingerprint, challenge, presenceSig }`.
  - The challenge is consumed before judging. The presence key must have signed `instar-owner-introduction-v1\n<approverId>\n<A host>\n<challenge>\n<line>`.
  - A then signs, with its **introducer key**, the exact bytes `instar-owner-introduction-v1\n` + `payload`. `payload` is this JSON in UTF-8, sent as base64url so the bytes verified are the bytes signed:

```json
{ "v": 1, "introducerKey": "<A's introducer key, base64url>", "introducerName": "Echo", "aud": "<audienceHost>",
  "deviceId": "<uuid>", "fingerprint": "XXXX-…", "iat": <ms>, "exp": <iat + 120000>, "nonce": "<16 random bytes, base64url>" }
```

- Answer: `{ introduction, signature }`, both base64url.
- Each signing appends one line to `state/mobile-introductions.jsonl` on A: the time, the approver device id, the audience host, the target device id and fingerprint, and a nonce hash. Never the signature. It also records feature evidence.
- A's bearer token reaches neither route (403 `device-signature-required`). So A's own sessions cannot get an introduction through the API.

### 3.3 Redeeming it: the waiting phone hands it to the new agent itself

On the new agent (agent N), one route signed by the **pending phone itself**: `POST /mobile/device/introduction` `{ introduction, signature }`. Allowlist row: statuses `pending` and `active` (so a phone whose success answer was lost can retry and read `active` at rule 6, as long as the introduction still passes rules 1–5; past its expiry the app reconciles with `GET /mobile/device`, §3.6), body `json` (not `unassignedOk`: only status, confirm and self-revoke answer a phone whose person was removed), its own 6/min bucket. An active signer is answered at rule 6 before the nonce is touched, so a retry is never mistaken for a replay; a replay while still pending is refused at rule 7. N checks, in order, refusing with one fixed code and one plain sentence each:

1. pairing and approve on (`isPairingApproveEnabled`), at least one valid introducer configured → else 503 `introductions-off`;
2. sizes (introduction ≤ 2048 chars, signature ≤ 128), base64url, JSON shape (all fields above, types and patterns) → 400 `bad-introduction`;
3. `introducerKey` equals a configured key → else 403 `introducer-unknown` (also recorded, so a rotation shows up: §4); the Ed25519 signature verifies over the domain line plus the exact decoded bytes with THAT configured key → else 403 `introduction-invalid`;
4. `now ∈ [iat − 30 s, exp]`, `exp > iat`, `exp − iat ≤ 300 s` → else 401 `introduction-expired`;
5. `aud` equals the Host this request was signed for (`signedHost`; the app sends to the exact host it put in `aud`, as #2813's `postDirect` does) → else 403 `introduction-wrong-agent`;
6. `deviceId` equals the signing device, whose row is pending with exactly `fingerprint` → else 403 `introduction-wrong-phone` (an already-`active` signer gets `{status:'active'}`, so a lost answer can be retried);
7. the nonce was not used before (memory, kept until `exp` + 60 s, at most 256 live; full ⇒ refuse) → else 409 `introduction-replayed`;
8. `approvePending(deviceId, 'owner-agent', { approvedBy: 'introducer:<keyId>' })`. All of the funnel's refusals apply unchanged (contested, two waiting, MSP, paused, moved) and answer exactly as the other approve routes do (`approveAnswer`).

Rule 6 is what makes it safe: an introduction can only finish the pairing of the phone that holds it. What the protocol proves is narrower than "the same phone", and the spec says so. A's owner phone approved, with Face ID, *this exact device id and key on this agent*. The device that redeems holds that key. The honest app fills in its own pending device's id, key and host, so in practice the person approving is holding the phone being added. That is an app invariant, not a cryptographic one: the server binds the approval to one exact pending key and no further.

`approvedVia: 'owner-agent'` is a new `ApprovedVia` value. The ledger and the registry take strings, and `originApprovedVia` readers show it as-is. `approvedBy` carries the documented prefix `introducer:<keyId>` (elsewhere it holds a device id). When N has a Telegram owner, a courtesy DM records it: "A phone was added to <N> with Face ID, vouched for by <name>: <device name> (key …). If that was not you, remove it on the Phones page."

### 3.4 What the waiting phone is told, and in what order

`waitingFields(d)` (the redeem answer and `GET /mobile/device`) lists only paths that can work **now**, easiest first:

1. `paired-agent`: introducers are configured and the row is approvable. Alongside it, `introducers: [{ name, keyId }]`. The app offers it only if one of ITS OWN owner-paired agents reports a matching `keyId` (§3.6).
2. `owner-phone`: an owner phone of this agent with a presence key exists here (unchanged).
3. `telegram`: only when the code went to a real Telegram owner chat (§3.5).
4. `dashboard`: only when the code is held for the pairing page **and that page is open and unlocked right now**. The pairing page and the legacy Phones tab poll `GET /mobile/pairing-approvals` every 10 s with an operator session. Each such read stamps the time, and `dashboard` is listed while the last stamp is under 25 s old. The symbol is "an operator-session read of the approvals list"; the state it stands for is "a person has the page open"; the 10-s poll is the corroboration. A script reading the list with a session counts as open: that is the accepted false-positive, and it only adds a line to the screen, granting nothing.
5. `code`: always last while the row can take a code. When the code is held for the pairing page, the answer adds `codeAt: 'pairing-page'` and `codePageUrl`, so the app can open that page and say honestly that it asks for the agent's PIN.

A non-approvable row (MSP, contested) still gets `['code']`. The list is re-read every 3 s, so an opened page or a second phone changes it live.

### 3.5 Feedback fb-cceb7986-efa: never pick an approval path that cannot deliver

`approvalPath()` becomes:

- a Telegram owner chat really exists (`ownerDM` wired AND `telegramOwnerPresent()`, now in both native modes) → `telegram`;
- else native conversations on, **or** at least one valid owner introducer configured → `dashboard` (the code is held in memory for the pairing page, as today);
- else → `null`, and the mint answers 409 `approval-unavailable` with a reason the agent can say in plain words: it has no Telegram chat with its owner, app pairing without Telegram is off, and no introducer is configured. The mint never hands out a link that cannot finish.

### 3.6 The app

- `PairingConfirmPath` gains `.pairedAgent = "paired-agent"`. `PairingWaitState` reads `introducers`, `codeAt` and `codePageUrl`.
- On the wait screen the app asks, **in parallel**, each of its other agents that it holds with a device key for `GET /mobile/introducer` (5-s timeout each). That route answers only when introductions are on there (503 otherwise), so a match means the path is usable now, not just that a key is configured. A match is a **candidate**, not a promise that the next approval succeeds. The app keeps every candidate whose `keyId` matches, in list order, and tries the next one if the first refuses. Every 30 s while the screen is open it re-asks **all** of its other agents (not only current candidates), whether or not it already has a match: an agent that timed out, was switched off or did not match before can become a candidate, and a rotated or switched-off introducer drops out. A refusal that says the path is unavailable (503, `no-identity`, `owner-phone-required`, `introducer-unknown`) drops that candidate until the next refresh; a network failure keeps a current candidate. No candidate → the path is not shown. After any unclear answer from the new agent (a lost or failed redeem), the app reads its own status with the signed `GET /mobile/device` before saying anything, so an activation that already happened is never reported as a failure.
- **One primary instruction**, the first usable path; everything else sits behind a closed "Other ways" group.
- For `paired-agent` the primary is a button:
  - header: "Add Pairtest";
  - button: "Approve with Face ID";
  - footer: "Use Echo, which is already on this phone, to approve Pairtest. Tap the button and confirm with Face ID. Nothing else is needed." (It does not say Echo created Pairtest: nothing in the protocol proves that.)
  - The Face ID prompt names the exact target: "Add the agent at pairtest-1106.dawn-tunnel.dev to this phone".
  - The flow: Face ID (one `LAContext`) → enrol the presence key on Echo if needed → challenge on Echo → presence signature → `POST /mobile/introductions` to the host the challenge came from → `POST /mobile/device/introduction` to Pairtest at the host named in `aud`, signed by the pending key → `active` → the screen closes.
  - A refusal is shown in plain words and the other ways stay. The funnel's `another-phone-waiting` is shown as "Someone else's phone is also waiting to pair with Pairtest, so this can't be approved. Ask for a new link." This phone cannot decline the other one.
- Plain words per path, primary form:
  - owner phone: "On your other phone, open Instar and tap Approve under Pairtest."
  - Telegram: "Open your private Telegram chat with Pairtest and tap Approve."
  - dashboard: "Pairtest's pairing page is open on its computer. Tap Approve there."
  - code with `codeAt: pairing-page`: "Type the code from Pairtest's pairing page. It asks for Pairtest's PIN." with an "Open the pairing page" button.
  - code otherwise: "Type the code Pairtest sent you."
- The key section stays (smaller) only when a path asks the user to compare it: owner phone, Telegram or dashboard. When `paired-agent` is the only approve path it is left out, because the app checks the key itself.

### 3.7 Switches

`mobilePairing.approve.enabled: false` turns everything new off: the redeem route, `paired-agent`, and the introducer routes (503), exactly like the rest of approve. An agent with no `ownerIntroducers` behaves as today, apart from the fleet-visible changes listed in the Maturation plan.

## Frontloaded Decisions

- **QR on the machine's screen: not built here.** With the pairing page open and unlocked on the machine, §3.4 item 4 already gives a one-tap Approve on that screen. A QR the phone scans would be a second way to do the same thing at the same precondition. A QR that *carries* the pairing, for the very first agent a person installs, is a separate installer feature. (Filed for the installer as feedback fb-d636e0ed-b37.)
- **A first agent with no Telegram and no other agent.** With native app conversations on (development agents), its code is held for the PIN-locked pairing page, as today. With them off (customer agents), the mint now refuses with `approval-unavailable` (§3.5) instead of handing out a link that could never finish. Neither is worsened here, and this is the one case the operator's "never a PIN in the path" rule still does not cover. (Filed for the installer as feedback fb-d636e0ed-b37.)
- **The introducer key is derived, not stored.** Settled by the relay-nonce finding. A separate stored key would need its own cross-machine adoption, which derivation gets for free.
- **The trust list lives in config, written by the creator's CLI**, not in a route (§3.1).

## 4. Security

| Attack | What stops it |
|---|---|
| **Stolen pairing link for N** | The thief's phone waits on N, but an introduction names one device id and fingerprint and is accepted only from that device (§3.3 rule 6). The owner's phone only ever requests introductions for its own pending key (the app fills it in). The thief would need A's owner phone and its Face ID. This is stronger than the tap paths: there is no key to compare and nothing to misread. |
| **The relay operator (or anyone on A's relay connection)** | It can get A's identity key to sign arbitrary bytes (§2). It cannot get the introducer key to sign anything: that key is derived, never used by the relay client, and signs only behind the owner-phone presence gate. A unit test checks that an identity-key signature over a well-formed introduction is refused. |
| **Replayed introduction** | A single nonce, a window of at most 5 minutes, bound to one pending row that stops being pending on success. |
| **Introduction for a different agent** | `aud` must equal the Host the pending phone signs for on N. |
| **A hostile agent that lists Echo as its introducer** | N writes the `introducers` list in its own wait answer, and Echo's introducer key is public, so any agent can make the app offer "Approve with Face ID". The damage is bounded: the phone only joins N, which the user's own link already pointed at, and Echo signs only for the host the owner phone names. The app's words make no claim about who created Pairtest ("Use Echo … to approve Pairtest"), and the Face ID prompt names the exact host. **Accepted residual**: a user who opens a link to an agent they did not want can add it with one tap instead of a code. |
| **An API-token holder on N** | Cannot add an introducer (config only, no route, a test pins it). Cannot forge A's signature. |
| **An API-token holder or session on A** | The introduction routes refuse the bearer token. **Accepted residual:** A's process can read A's identity seed from disk and so derive the introducer key. Code running as A's OS user can therefore sign an introduction for any phone. N trusts A by its creator's choice, and that creator (usually A itself) already had full control of N at creation. This is the same class as "a process running as the agent's OS user can already read the PIN" (mobile-device-keys §2.2). |
| **A's identity rotated** | The introducer key changes with it. N's old entry still verifies signatures made with the **old** key until it is removed: trust is revoked by `instar mobile introducer remove` plus a restart **on every machine of N**, never by the rotation alone. **Accepted residual:** between a removal on one machine and the same removal on the others, those others still accept the old key (each only into its own registry). After the rotation the app no longer offers the path (keyId mismatch), and N records each `introducer-unknown` arrival, so a stale entry is visible. The creator re-runs `show` and `add`. |
| **Wrong owner (an MSP's phone)** | `approvePending` refuses MSP rows (`code-only`), and the introducer gate requires an *owner* phone on A. |
| **Two phones waiting on N** | The funnel rule is unchanged: refused until one is declined. The app says to ask for a new link (§3.6). |
| **Flooding** | Device bucket 6/min on N, 12/min on A, nonce cache capped and failing closed. |

## 5. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Introducer route gate (device principal, owner phone, local TLS, challenge, presence signature) | invariant | Cryptographic and registry checks, same shape as #2813. |
| Introduction verification on N (configured key, Ed25519 signature, time window, audience, device, nonce) | invariant | Exact cryptographic and equality checks, no judgment. It can only lead into the existing funnel. |
| `confirmWith` composition, including the pairing-page-open stamp | invariant | A deterministic display signal, never an authority: it decides what the phone is told and grants nothing. The P20 statement is in §3.4 item 4. When it cannot be measured (no stamp), the result is "not listed", which removes a line and never adds authority. |
| `approvalPath()` | invariant | Enumerated configuration states. The change makes it refuse rather than mis-route. |

## Constitution check

No brittle check gains blocking authority (`docs/signal-vs-authority.md`). Every new refusal is a cryptographic or exact-state check, and every refusal leaves the code path open.

- **Know Your Principal** (`docs/STANDARDS-REGISTRY.md`): the new agent seats a phone as its owner's only on a verified chain. The owner's Face ID was given on a phone that A already verified as A's owner phone. A's introducer key attests to it, and N holds that key because its creator wrote it into N's own config. A name in a request (`introducerName`, a device name) is display text and never chooses the key.
- **The User Experience Is the Product**: the wait screen shows only ways that can work now. No guard leaves the user stuck: every refusal leaves the code path open.
- **No Manual Work**: the creator's step is a command (§3.1), not a remembered paragraph.
- **Signal vs authority**: see §5.
- **The operator's 2026-11-02 rules**: one safety step (Face ID, once); no look-alike numbers to compare on the `paired-agent` path; no dashboard PIN on that path; a code kept. The one case they still do not cover is named in Frontloaded Decisions.

## Open questions

*(none)*

## 6. Multi-machine posture

- **A's introducer key: unified.** It is derived from the identity that every machine of A adopts (agent-identity continuity), so every machine signs with the same key and N needs one entry per agent, not one per machine.
- **A's challenge and audit: machine-local by design.** The challenge lives 60 s in the process that issued it, and the app posts the answer to the host the challenge came from (as #2813 does). The audit file records what that machine signed.
- **N's pending row, nonce cache and activation: machine-local by design**, as with every other approve path. The phone signs to the machine that holds its row.
- **N's trust list: replicated at join, like the identity.** `.instar/config.json` does not sync between machines, so the list rides the same code-authenticated pairing response that carries the agent identity to a joining machine: the inviter adds `ownerIntroducers` (names and public keys only) to its machine-pairing answer, and `instar machine join` writes it into the joiner's config before the joiner first starts (never overwriting a list already there). A later change is made with the CLI on each machine (`add`/`remove`), the same way every other config edit on a multi-machine agent is made today. A machine without the list does not offer `paired-agent` (fail-safe: the code and the other paths remain), and the list only gates activations into that machine's own device registry, so a stale copy can never approve something another machine holds.
- **The pairing-page-open stamp: machine-local by design.** The page polls the host the phone redeemed on (its `codePageUrl`), which is the machine that holds the code.

machine-local-justification: physical-credential-locality impossible-because="the credential an introduction activates is the waiting phone's key in the holding machine's own device registry, which that machine's TLS name and device authentication read; the challenge, nonce cache and page stamp exist only in that machine's process" permanence=permanent

## 7. Tests

- **Unit:**
  - Introduction sign and verify: good; a flipped byte; another key; the identity key itself (refused); expired; a future `iat`; a window over 5 minutes; wrong `aud`; wrong device; wrong fingerprint; a replay; an unknown introducer; a malformed config entry ignored.
  - The derived key: deterministic, and different from the identity key.
  - `approvalPath()` across Telegram owner present/absent × native on/off × introducer present/absent.
  - `waitingFields`: the order, and the page-open stamp's 25-s window on both sides.
  - The CLI: add, remove and list, with an atomic write that keeps the file mode.
  - The machine-pairing answer carries the list (names and keys only) and the joiner writes it without overwriting an existing one.
- **Integration (HTTP):**
  - On A: bearer refused on both introduction routes; an MSP phone refused; no presence key → 409; the full challenge flow → an introduction that verifies.
  - On N: a pending phone redeems a valid introduction → `active` with `approvedVia: owner-agent`; repeating that successful redemption answers `active`; another pending phone's introduction is refused; a consumed nonce reused while the signer is still pending is refused (`introduction-replayed`); switch off → 503.
  - Mint on a Telegram-less, native-off agent with no introducer → 409 `approval-unavailable`; with an introducer → 200 with `codePageUrl`.
  - A config PATCH of `mobilePairing` is refused.
- **E2E:** a production `AgentServer` boot of two agents in one test. A has an owner phone with a presence key. N has A as introducer, no Telegram, and native off. The test mints on N, redeems, has A issue an introduction, has N activate the phone, and the phone then reads `GET /health` signed.
- **Live:** the pairtest VM with this build, driven from the simulator (the Maturation plan).

## 8. Rollback

`mobilePairing.approve.enabled: false` turns the introduction routes off, live. A revert removes the code. Phones approved this way stay paired as ordinary `active` rows, and `approvedVia: owner-agent` is just a display string to older builds. Reverting §3.5 brings back links that cannot finish on Telegram-less agents, which is the old defect. Reverting §3.4 brings back the dashboard line shown regardless of whether the page is open.

## Maturation plan

- **Fleet-visible on update, with no introducer configured** (argued, no dark window):
  - (a) The mint refuses on an agent that could never finish a pairing. Before, it minted a dead link.
  - (b) The wait screen stops naming the dashboard unless the pairing page is open. The code and the page link remain.
  - (c) The introducer routes exist on every agent with approve on. They need that agent's owner phone and Face ID, and their output is accepted only by an agent whose creator listed this agent.
  - Each change removes a dead end or adds an owner-gated capability. None blocks something that worked.
- **test-agent-live:** the §7 unit, integration and E2E tests on a real server boot.
- **dev-agent-live:** the pairtest VM (auto-update off) on this build, with a throwaway introducer agent and two simulators:
  - one with no paired agents, which sees only the code way and the pairing-page link;
  - one already owner-paired with the throwaway agent, which sees "Approve with Face ID" and finishes with it.
  - Justin's real phone stays paired with pairtest and is not touched.
- **fleet:** the introducer path does nothing until a creator writes `ownerIntroducers`. It follows `mobilePairing.approve.enabled`, which is on wherever pairing is on.
- **graduation criterion:** the next agent Echo creates for Justin is added to his phone with one Face ID tap and no chat round-trip.
- **dark-window:** not applicable. The introducer path is inert until configured, and the fleet-visible parts are argued above.
- **ladder:** mobilePairing
