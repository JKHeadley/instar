---
title: "The approver mark lives in the owner record (piece 3a: server core)"
slug: identity-security-piece3a-approver-in-owner-record
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece3a-approver-in-owner-record.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Verify the State, Not Its Symbol; Bounded Blast Radius"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §11 decision 1 (mobile-approver-mark built as piece 3, marks in the owner record), §12 item 3; mobile-approver-mark.md §3.1–§3.6 (approved design this adapts)"
depends-on: "identity-security-piece2a/2b/2c/2d"
lessons-engaged: "verify-the-state-not-its-symbol, a-dark-guard-is-worse-than-no-guard, cut-the-sequence-not-just-the-scope"
review-convergence: "2026-11-18T18:52:00Z"
review-iterations: 5
review-completed-at: "2026-11-18T18:52:00Z"
review-report: "reports/identity-security-piece3a-approver-in-owner-record-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), §11 decision 1 and §12 item 3, adapting the approved mobile-approver-mark.md §3.1–§3.6, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The approver mark lives in the owner record (piece 3a: server core)

## Problem statement

Today any paired owner device can register a presence key (`POST /mobile/device/presence-key`) and then approve Sensitive actions. On Windows any program in the owner's login can do that silently. mobile-approver-mark fixes it with an **approver mark** that only the agent sets. The umbrella (§11, decision 1) builds it as piece 3, with one change: marks live in the **owner record**, not in per-machine device files. A mark is then signed, checked by every machine, and kept in step by pieces 2a and 2b.

Piece 3 is cut into four. This is 3a, the server core:
- **3a:** the mark as an owner key in the record; the first approver by private-chat claim; giving and removing the right; devices that hold a presence key today; one reader for every presence-gated route.
- **3b:** the attested first approver for agents with no private chat (mobile-approver-mark §3.14).
- **3c:** the app builds that sign record entries (iPhone, Android, Mac), and the Windows app's "cannot approve" label.
- **3d:** recovery of a lost approver (§3.8) and the person-acts rules (§3.9).

## Proposed design

### 1. Owner keys are presence keys, and the app signs what it shows

- **A second key type.** An owner key in the record is a device's presence key: a raw uncompressed P-256 point (65 bytes, base64url, as `parseDevicePublicKey` reads it), ECDSA with SHA-256, strict low-S DER signatures. These are the checks `verifyPresenceSignature` makes today. 2a gains `keyType: 'p256'` on `add-owner-key` and checks each signature by its key type. Machine keys stay Ed25519.
- **What an owner key signs: the entry, hashed by the app.** The server sends the device the **full unsigned entry**. The app renders the summary from the entry's own fields, computes the entry id itself (2a's canonical form), and signs `instar-owner-record-v1\n<agentId>\n<entryId>` with Face ID. The server never hands the app an id to sign blind (3c builds this; until then only the scripted stand-in phone of the proof does it).
  - The `instar-owner-record-v1` prefix is unique among presence message formats, so no other presence signature can be replayed as a record signature, or the reverse. A test lists every presence message prefix and checks they don't collide.
  - `agentId` must match `^[A-Za-z0-9._-]{1,64}$`: no newline can forge the framing.
- **Key ids come from the key itself.** A device's owner-key id is `o_` plus the first 24 hex characters of sha256(`instar-owner-key\0` + presenceKey).
  - A phone paired with two machines (two device ids) has one owner key.
  - Owner keys are matched to a device by public key, never by device id.
  - A reinstalled app has a new presence key, so it gets a new id, and 2a's "never reuse an id" rule never blocks a device from coming back.

### 2. The record needs a machine key, without changing how a lone agent listens

- **A paired agent** (with a machine identity) uses its machine key for the genesis, as in 2b.
- **Every machine's key is in the record before any owner key exists.** While the record has no owner key, 2a accepts an `add-machine-key` signed by the machine it adds (self-signed, like its TLS key). At Basic the record is agent-producible, so this grants nothing new. 2b adds each machine's key once, on that machine. So any lease holder can attest the first owner key against the record, even after the lease moves or the genesis machine is gone. After the first owner key, only owner keys add machines.
  - **Only the machine's real key.** 2b accepts a self-signed `add-machine-key` only from a registered machine whose registered key matches the key it adds.
  - **Forks are merged while there is no owner.** Machines adding their keys at about the same time can fork the record. While the record has no owner key, the lease holder merges any fork with a machine-signed `merge` (2a allows that before an owner exists) within one pull cycle.
  - **No new machine during a claim.** While a first-approver claim is live (from its start until it completes or lapses), the lease holder refuses to pair a new machine (`409 owner-claim-in-progress`) and won't take in a self-signed `add-machine-key`. Nothing can fork the record between the claim's check and its signed entry.
  - **The claim needs a whole record.** The claim and sign steps (§3) require an unforked record, with every registered machine's key on the main chain. Otherwise a first owner key could land on a branch, held, with no owner key able to merge it.
- **A lone agent** (no machine identity) gets a **record-only key**. It is created at the first claim, in `.instar/machine/owner-record-key.pem` (0600, key material), with a machine id `m_local_` plus the first 16 hex characters of its key's hash.
  - It is never a mesh identity, so the multi-machine coordinator, the 0.0.0.0 bind and mesh endpoint adverts all stay off. A loopback-only agent stays loopback-only.
  - 2b treats it as the registered key for that genesis.
  - **Pairing a second machine later.** The pairing response (`POST /api/pair`) carries the inviting machine's pinned genesis id. The joiner pins it at once (2b: "a machine joining later pins at the join handshake"), so it adopts the enrolled record even though its own registry doesn't hold the `m_local_` key. The new machine's own key joins the record through an owner-signed `add-machine-key` (the app signs it, 3c).

### 3. The first owner key: a private-chat claim with a proof the record itself can check

This follows mobile-approver-mark §3.3, with the record as the store.

- **Open only when all hold**, checked fresh at claim time and again at confirm:
  - **No owner key in the record, ever.** This machine's record says `everEnrolled: false`. Every registered machine is asked now with an `owner-record-pull`, and each must answer within 10 seconds with no owner key and no enrolled marker naming this agent. A silent machine, or one on an older build, closes the claim and is named.
  - **Every machine runs a build with this piece.** The 2c ledger holds a fresh signed statement at or above the 3a build for each machine. An older build would still honour any presence key.
  - **The device was let in through the owner's private chat** (`approvedVia: 'telegram-dm'`).
  - **No other unvouched device is paired** (§3.3 condition 3). Every other active owner record that isn't a browser, on every machine, is a kept approver (§5) or carries `legacyPersonActs`.
  - **This machine holds the lease, with no split-brain reported** (a lone agent counts as its own holder), and serves the private chat.
  - **The record is whole:** not forked, with every registered machine's key on the main chain (§2).
- **Three steps:**
  1. **Claim.** `POST /mobile/approver/first { presenceKey, presenceProof }`, device-signed. The claim code goes to the private chat with the §3.3 text, 30 minutes, three tries, at most three claims per machine a day.
  2. **Code.** `POST /mobile/approver/first/confirm { code }`. Only after a correct code does the server build the entry: on a lone agent it creates the record-only key and the genesis if needed, then builds the first `add-owner-key` with its proof (below). It returns the full unsigned entry.
  3. **Sign.** `POST /mobile/approver/first/sign { entry, sig }`. The device signs the entry it was shown (§1). The server re-checks every condition, then ingests the entry, and 2b carries it to every machine and pins the genesis.
- **The proof, checkable from the record alone.** `body.proof` is `{ by: <machineId>, sig }`. `sig` is an Ed25519 signature by that machine over `instar-first-owner-v1\n<agentId>\n<parent entry id>\n<deviceId>\n<owner key id>\n<presenceKey>`. 2a passes its proof hook the entry's parent fold. The hook verifies the signature against **that machine's key as it stands in the record at the parent**: the genesis key, or a machine key added before.
  - A key later rotated or retired doesn't matter: authority is judged in the entry's own ancestry.
  - The proof binds the parent, the device and the key, so it can't be replayed onto another entry.
- **What it rests on.** At Basic the record is agent-producible, and owner-authentication §6 accepts that the agent writes the first owner key. The chat code is the human step; the attestation records that the lease holder checked it.

### 3b. Where the limits come from

| Limit | Source |
|---|---|
| Claim code: 30 minutes, three tries, three claims per machine a day | inherited unchanged from mobile-approver-mark §3.3 (approved), which applies the pairing code's own rules; widening them widens a guessing window on the one step that makes the root key |
| 10 seconds for every machine to answer at claim time | two mesh round trips at the mesh client's default 5-second timeout. A machine that misses it is named, and the owner can claim again at once (a silent machine closing the claim is §3.3's fail-closed rule) |
| `agentId` ≤ 64 characters from `[A-Za-z0-9._-]` | the signed-framing floor: no newline or separator can enter. Agent ids are project names, which already fit it, and a longer or other id is refused with a plain reason rather than signed |

### 4. Giving the right to another device

This follows mobile-approver-mark §3.4.

- **The request and the yes.** A paired owner device asks (`POST /mobile/approver/request`). An approver signs an `add-owner-key` for it (owner-key-signed, §1).
- **Only when the record is whole.** Grants are refused while the record is forked (2a `forked`) or held for any reason, and the reason is named.
- **Forks are resolved by an owner-signed `merge`,** offered to an approver as a card (3c signs it; the proof uses the stand-in phone).

### 5. Devices that approve today: kept, exactly as §3.6

- **§3.6 unchanged, in its own local state file.** `migrateApprovers()` runs §3.6 as written: the cutoff asked of every machine, the audit-row test, `kept` per machine, `legacyPersonActs`, the owner notice listing kept devices by name and fingerprint, and the rule that it never runs again after a rollback. Its state is the local file `state/mobile-approver-state.json`.
- **A kept device approves actions** through `approverKey`, with §3.6's limits while the cutoff is unconfirmed.
- **What a kept device can't do.** It is not an owner key, so it can't sign record entries: it can't grant, remove or merge. It enters the record like any device: by the chat claim of §3 while the record has no owner key, which needs the code, or by an approver's grant.
- **No window, no automatic promotion.** Nothing a kept device can do gives it more than §3.6 gives it today. A program that registered a presence key before the release is listed in the owner's notice, and it can never become the record's root without the chat code.

### 6. Removing the right

This follows mobile-approver-mark §3.5.
- **The entry.** An approver signs `revoke-key` for another device's owner key.
- **The dashboard or the agent's token alone can't disable an approving device** where a private chat exists (§3.0 point 7). Revoking a marked device through the existing path answers `202 pending-owner-confirm`.
  - The device keeps its mark until the owner taps yes in the private chat.
  - Then the device record is revoked, and an approver's app signs the owner-key revocation.
  - On an agent with no private chat, an approver's signature is the confirmation.
  - Unmarked devices are revoked at once, as today.
- **The last owner key can't be revoked** until recovery (3d) exists. The refusal says so, because revoking it would hold every Sensitive action with no way back.

### 7. One reader

- **`approverKey(rec)`** returns the device's presence key when the gate doesn't hold, the device record passes `activeOwnerPhone`, and either:
  - the record's valid owner keys include this device's key id with that public key; or
  - the device is a kept approver (§5).
- **`verifyApproverPresence`** checks it, then records `lastPresence`, written and synced before the action answers. If that write fails, the action is refused (§3.1).
- **The presence-key route** keeps its §3.2 checks: one key per device, distinct from the device key and from every other key held.
- **The ratchet** (§3.1) fails the build when any file but `MobileDeviceKeys.ts` and the approver module reads `presenceKey` or calls the presence verifier directly.
- **"Agent-wide" means the record.** A device uses its mark on any machine where it is paired.

## Decision points touched

- **Who may approve:** a valid owner key for the device in the record — invariant; basis: external-constraint; evidence: umbrella §11 decision 1.
- **The first approver:** a private-chat claim, attested by the lease holder's machine key — invariant; basis: irreversible-consequence; evidence: mobile-approver-mark §3.3; owner-authentication §6.
- **Kept devices follow §3.6 unchanged; only the chat claim or an approver's grant puts a device in the record** — invariant; basis: irreversible-consequence; evidence: review round 1 (no machine-key path to the root).

## Multi-machine posture

The record is unified through 2b. Claims are local to the lease holder (physical-credential-locality: a one-time code bound to the machine that issued it).

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| A device may approve | a presence key on its record | a valid owner key in the signed record for that device | the presence signature verifies against that key | a stolen unlocked phone (stated limit) |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | A throwaway agent with a scripted stand-in phone (P-256 keys over the real device-signed API): claim, confirm, grant a second device, revoke, approve an action. | revert |
| dev-agent-live | After 3c ships the app, on Echo with Justin's phone (a card). | revert |
| fleet | With 3c. | revert |

## Tests and evidence

- **Unit:**
  - 2a with P-256 owner keys;
  - `approverKey` and `verifyApproverPresence`;
  - every claim condition both ways;
  - the attestation proof checked on another machine;
  - grant and revoke;
  - kept devices under §3.6;
  - the ratchet.
- **Integration:** the claim and confirm routes, and a presence-gated route refusing an unmarked device.
- **E2E lifecycle:** the routes are alive through the production wiring.

## Maturation plan

- **ladder:** not applicable: mobile-approver-mark's approved decision 10 is "there is no switch and no dev gate". The mark is a security fix that must reach every agent, and a switch would leave the Windows hole open wherever it stayed off. Graduation is by the evidence steps below, recorded in the build folder, each with its date and outcome.
- **test-agent-live:** the scripted-phone proof.
- **dev-agent-live:** after 3c, on Echo.
- **fleet:** with 3c.
- **graduation criterion:** an approval on a real phone goes through the record on a two-machine agent.
- **dark-window:** none.

## Open questions

None. The question about a lone agent's machine identity was answered by the code: it would turn on mesh binding. So §2 uses a record-only key instead.

## Left behind

- 3b (attested first approver), 3c (apps), 3d (recovery and person acts).

## Review history

- **Round 1 (8 design, 1 precision), applied:**
  1. The first-owner proof is checked against the attesting machine's key in the record at the parent, and the entry is built only after the code.
  2. The app hashes the full entry it shows.
  3. Kept devices follow §3.6 unchanged and can't become root without the code: no window and no countersign.
  4. A lone agent gets a record-only key, never a mesh identity.
  5. Revocation is signed, the dashboard alone can't disable an approver, and the last owner key can't be revoked before 3d.
  6. Every machine is asked fresh at the claim; grants are refused while the record is forked; merges are a signed card.
  7. Key ids include the presence key.
  8. §3.3 condition 3 is restored with kept devices counted as vouched, and every machine must run the 3a build.
  - Precision: raw 65-byte points; the proof hook is wired with the parent fold; `agentId` has no newline.
- **Round 2 (3 design, 4 precision), applied:**
  - Each machine adds its own key to the record at Basic (self-signed), so any lease holder can attest.
  - The pairing response carries the pinned genesis, so a lone agent's record survives pairing.
  - A marked device revoked by token or dashboard waits for the owner's tap (202).
  - Precision: key ids derived from the presence key with a separator and matched by public key; no split-brain at claim; the stale test line removed.
- **Round 3 (1 design, 1 precision), applied:**
  - While no owner key exists, the lease holder merges forks from concurrent machine-key additions with a machine-signed merge.
  - The claim requires an unforked record with every machine's key on the main chain.
  - A self-signed machine add is accepted only when it matches that machine's registered key.
- **Round 4: converged.** Precision applied: no pairing and no machine self-add while a claim is live.
- **Constitution check (fit) and GPT-6.2 Astra:**
  - Each limit's source is in §3b (Judgment Within Floors).
  - The ladder exception cites approved decision 10 (Maturation Path).
  - The plain-language summary is corrected on kept devices.
  - Astra's other findings re-reviewed piece 1, already built and reviewed.
- **Choices made while building (2026-11-18):**
  - "Every machine runs a build with this piece" is checked from the 2c ledger. Each machine's fresh signed build statement must name the new `approver-record` guard. There is no 3a version number to compare against before release, so the claim checks the feature itself. The pull reply's `approver` field is required too, but is never enough on its own, because replies aren't signed.
  - §3.6's cutoff across machines works the same way. Each machine reports when it ran the migration, and the earliest time moves every machine's cutoff back. That can only shrink the kept list. The cutoff is confirmed once every machine has answered.
  - The owner's Decline tap on "remove an approving device" answers "Kept. That device can still approve." The pairing wording isn't used.
  - Grants (§4) follow §3.4's match code. The asking device shows a six-digit code, and the owner types it on the approving device (`POST /mobile/approver/lookup`). Requests are never listed. The approver's app gets the full unsigned entry and signs its id; 3c builds the app side.
  - **The lookup reaches only the machine the approver is paired with.** A device asking on another machine asks again on the approver's machine. This keeps the code exchange off the mesh. Because the record is agent-wide, the granted key then works everywhere.
  - **An owner key in the record may be registered on any machine** by the device holding it (proof of possession, no other live device holding it). This is how the mark is agent-wide (§7) when one phone is paired with several machines under different device ids.
  - **Removal (§6) has its record half.** An approver signs `revoke-key` (`/mobile/approver/revoke/draft|sign`); that is the confirmation where there is no private chat. "The last device that can approve" counts only owner keys whose device is still active (on this machine, or unseen here).
  - **Kept devices and `legacyPersonActs`** live in the local state file (`kept`, `legacy`), not on device records.
  - **The local key override** (app-trust-approval §D) is refused for a device that approves (`409 approver-key-locked`), as §3.5 says. Its new key would be in neither the record nor the kept list, so the device would silently stop approving.
  - **Residual:** the local-owner ticket (`mobileLocalOwnerDevice.ts`) can still replace this computer's own local device, without a tap. It needs access to the agent's own computer, which the design already treats as the owner.
