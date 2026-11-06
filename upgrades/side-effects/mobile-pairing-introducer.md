# Side-Effects Review — Add a new agent from a phone you already use

**Version / slug:** `mobile-pairing-introducer`
**Date:** `2026-11-06`
**Author:** `echo (builder session)`
**Second-pass reviewer:** `required: independent subagent (see below)`
**Spec:** `docs/specs/mobile-pairing-introducer.md` (converged at round 5, approved under Echo's standing grant)

## Summary of the change

A phone that is already the owner's phone on one agent (A) can add a NEW agent (N) with one Face ID tap. The flow:

1. N's creator writes A's introducer key into N's config, with `instar mobile introducer add`.
2. The waiting phone gets A to sign a two-minute introduction for its own pending key on N. A signs only after a presence signature from its owner phone, and signs with a key derived by HKDF from A's identity seed, never with the identity key itself.
3. The phone hands that introduction to N, which verifies it against the configured key and runs the existing approval funnel (`approvedVia: owner-agent`).

Also in this change:

- The wait screen's `confirmWith` lists only paths that work now, easiest first: `paired-agent`, `owner-phone`, `telegram`, `dashboard` (only while the pairing page is polling), `code` (with `codeAt` and `codePageUrl`).
- `approvalPath()` no longer picks Telegram without a real Telegram owner (fb-cceb7986-efa). The mint refuses with `approval-unavailable` when no path can deliver.
- The introducer list rides the machine-pairing answer to a joining machine.

Files:

- `src/server/mobilePairingIntroducer.ts` (new)
- `src/server/mobilePairingRoutes.ts`
- `src/server/AgentServer.ts` (`readIdentity`)
- `src/server/machineRoutes.ts` (`ownerIntroducersForJoin`)
- `src/commands/machine.ts` (the joiner writes the list)
- `src/commands/mobileIntroducer.ts` (new) and `src/cli.ts` (the CLI)
- `src/core/MobileDeviceKeys.ts` (`ApprovedVia`)
- `src/core/PostUpdateMigrator.ts` (awareness line plus migration)
- tests: unit, integration, E2E, and updates to existing pairing tests for the new `confirmWith` order

Tier 2. Spec rounds: 5.

## Decision-point inventory

- Introducer route gate on A (device principal, owner phone, local TLS, challenge, presence signature): **add**, invariant.
- Introduction verification on N (configured key, Ed25519, window, audience, device, nonce): **add**, invariant. It feeds only the existing `approvePending` funnel.
- `approvalPath()`: **modify**, invariant. It now refuses rather than mis-routing.
- `confirmWith` composition plus the pairing-page stamp: **modify**, a display signal that grants nothing.

---

## 1. Over-block

- On a customer agent (native off) with no Telegram and no introducer, the mint now refuses. Before, it minted a link that could never be confirmed, so nothing that worked is lost.
- The `dashboard` line now disappears while the pairing page is closed. The code is still reachable through `codePageUrl`, and Approve still works on the page once it is open (the line comes back within one 10-s poll).
- An introduction redeemed after 2 minutes is refused as expired. The app asks again (a fresh Face ID).
- The nonce is spent before the funnel answers. If the funnel then refuses (`another-phone-waiting`, `paused`), a retry needs a fresh Face ID. That is safe, and only costs a tap.
- A native-off agent that has a Telegram adapter but no resolved owner id now refuses at mint. Before, it minted, then failed at redeem when the DM could not be sent. This is the intended fix.

## 2. Under-block

- **Accepted, and stated in the spec:** code running as A's OS user can read A's identity seed, derive the introducer key, and sign any introduction. The same class as reading the PIN.
- A removal reaches only the machine it runs on, and the others keep the old key until the same removal runs there.
- A hostile agent can list A's public introducer key and get the "Approve with Face ID" button shown. The damage is bounded: the phone only joins the agent the user's own link pointed at.

## 3. Level-of-abstraction fit

The change rides the existing approve funnel (`approvePending`), the existing presence-key challenge pattern (#2813) and the existing device allowlist. The only new primitive is the introduction, a signed statement verified against a config-held key. A derived key was chosen over a new stored key so that identity adoption gives cross-machine continuity for free.

## 4. Signal vs authority compliance

No brittle check gains blocking authority. Every new refusal is a cryptographic or exact-equality check (`docs/signal-vs-authority.md`, "hard-invariant validation"), and every refusal leaves the code path open. `confirmWith` is display-only.

## 4b. Judgment-point check

No judgment decisions: all the new decision points are invariant, as classified in the spec §5.

## 5. Interactions

- **The `approvePending` funnel** is unchanged. The introduction path inherits contested, two-waiting, MSP, paused and moved.
- **Device authenticator:**
  - New allowlist rows: `/mobile/introducer` (active, ownerOnly); `/mobile/introductions(/challenge)?` (active, ownerOnly, the shared `pairing-approve` bucket); `/mobile/device/introduction` (pending+active, its own bucket).
  - An active signer on the redeem route is answered `active` before the nonce check.
- **Existing tests** that asserted `['dashboard','code']` or `['telegram','owner-phone','code']` are updated. The order is now owner-phone before telegram, and dashboard only while the page is open.
- **The relay signing oracle** (`fb-0b697128-30f`) is avoided by the derived key. It is not fixed here.

## 6. External surfaces

- **New routes:** `GET /mobile/introducer`, `POST /mobile/introductions/challenge`, `POST /mobile/introductions`, `POST /mobile/device/introduction`.
- **New wait fields:** `introducers`, `codeAt`, `codePageUrl`; new `confirmWith` value `paired-agent`; new `approvedVia` value `owner-agent`.
- **Machine pairing:** the pairing answer gains `ownerIntroducers` (public keys and names only).
- **New CLI:** `instar mobile introducer show|add|remove|list`.
- **Shipped apps** ignore the new fields and value: an unknown `confirmWith` entry is skipped by the app's parser, which was read from source.
- **New audit file on A:** `state/mobile-introductions.jsonl` (no signatures, a nonce hash only).

## 6b. Operator-surface quality

The app's wait screen is the operator surface, built on the app branch `echo/new-agent-approve`. There is one primary instruction, with the rest under "Other ways", in plain words. No dashboard change.

## 7. Multi-machine posture

- **A's introducer key: replicated.** It is derived from the adopted agent identity, so it is the same on every machine.
- **N's trust list: replicated at join** through the code-authenticated machine-pairing answer. Later edits are made per machine with the CLI, as stated.
- **Pending row, nonce cache, challenge and page stamp: machine-local by design.** They are the credential locality of the device registry, as on every approve path.
- **Notices:** the courtesy DM goes through the existing `ownerDM`, only on activation, on the holding machine.
- **URLs:** `codePageUrl` names the host the phone redeemed on.
- **No status, health, capabilities or channels surface changes.**

## 8. Rollback cost

- `mobilePairing.approve.enabled: false` turns the new routes off, live.
- A revert is a plain patch. Phones activated with `owner-agent` remain ordinary active rows. The `ownerIntroducers` config entries become unread.
- Reverting brings back the dead-link mint on Telegram-less customer agents, and the always-shown dashboard line.

## Conclusion

The review moved the signing key off the identity key, because the relay signs raw nonces with it. It also changed the dashboard line from "session exists" to "page is polling", and turned the creator's step into a command. It is clear to ship after the second pass.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (code read, not artifact-only), 2026-11-06
**Independent read of the artifact: concur**

No path lets anything other than the owner's phone with Face ID on A activate a phone on N. The reviewer checked each case: the bearer on A or N, the relay oracle, replay, another pending phone, the wrong audience, and MSP, contested or paused rows. The verification order, the allowlist rows and the join carry all match the spec, and no exception path leads to an approval.

Minor notes, none blocking:

- The nonce is spent before the funnel answers. This is now recorded under Over-block.
- The challenge store's per-device cap is keyed per approver and target, so one owner phone can push out only its own owner's challenges. The global total and the 12/min bucket still bound it.
- The Over-block section understated the `approvalPath()` change. Now corrected.
- The joiner's write is not atomic and does not re-check keys or names. Cosmetic: the inviter filters first, and the server re-checks every entry at read.

## Evidence pointers

- Unit: `tests/unit/mobile-pairing-introducer.test.ts`
- Integration: `tests/integration/mobile-pairing-introducer.test.ts`
- E2E: `tests/e2e/mobile-pairing-introducer-alive.test.ts`
- Live proof on the pairtest VM: see the PR body.
