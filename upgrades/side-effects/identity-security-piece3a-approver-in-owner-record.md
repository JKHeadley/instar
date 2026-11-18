# Side-Effects Review — Only the owner's own phone can make itself able to approve

**Version / slug:** `identity-security-piece3a-approver-in-owner-record`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Piece 3a of the approved identity and security design (topic 144636). It adapts the approved mobile-approver-mark §3.1–§3.6, with the signed owner record as the store.

- **One reader decides who may approve.** `src/server/mobileApprover.ts`:
  - `approverPresenceKey` / `mayApprove` / `verifyApproverPresence` answer yes only when the device is an active owner phone, the record's gate isn't holding, and its presence key is a valid owner key in the record or it is a kept device.
  - Every presence-gated route now goes through it: console ticket, desktop unlock and PIN reveal, action approvals, permission writes, pairing approval, introductions, documents, team access and trust approval.
  - A ratchet test fails the build when any other file reads a device's presence key or checks a presence signature directly.
  - `verifyApproverPresence` records the approval before the action answers. A failed write answers 503.
- **Owner keys are presence keys.** 2a accepts P-256 owner keys (`keyType: 'p256'`, strict low-S DER) signed over `instar-owner-record-v1\n<agentId>\n<entryId>`. A machine may add its own key self-signed while the record has no owner key. The store adds this machine's key once and merges forks at Basic.
- **The first approver** (`src/server/mobileApproverClaim.ts`) takes three steps:
  1. A claim sends a word code to the owner's private chat.
  2. The device confirms with the code and gets the full unsigned entry.
  3. The device signs the entry's id.

  Every condition is checked fresh at each step: no owner key anywhere, every machine answering with this build, no unvouched device, the lease held, the record whole. The entry's proof is signed by this machine's record key and checked against the record at the parent. A lone agent gets a record-only key (`.instar/machine/owner-record-key.pem`), created only after a correct code.
- **More approvers** (`mobileApproverGrant.ts`): a device asks, and an approver's owner key signs the `add-owner-key`. This is refused while the record is forked or held. Kept devices can't grant.
- **Removing an approver** (`mobileApproverRevoke.ts`):
  - The token or another device gets `202 pending-owner-confirm`, and the owner's Approve tap in the private chat removes the device.
  - The last owner key can't be removed.
  - Without a private chat, the answer is `approver-signature-required`.
  - A device that can't approve can't remove a device with a live claim.
- **Kept devices** (`migrateApprovers`, once per machine): active owner phones that held a presence key before this release, minus any whose key was set at or after the cutoff. The cutoff moves back to the earliest migration any machine reports. That only shrinks the list. The owner gets one attention item listing the kept devices.
- **The presence-key route** stores a key only for a device that may already approve (§3.2). Any other device gets `403 approver-required`.
- **The list the apps read** (mobile-approver-mark §3.10):
  - `GET /mobile/approvers` (owner device, device-signed) answers who can approve, whether this device may, its own pending request and match code (only to itself), how many wait, and whether the first-approver claim is open, checked again at start.
  - `/health` reports `approverMark: 1`, which the Windows app checks before pairing.
- **Joins:** a machine can't join while a claim is live. The join answer carries the pinned genesis, which the joiner pins at once.

## Decision-point inventory

- `approverPresenceKey` (who may approve).
- The claim's conditions.
- The grant's readiness check.
- The removal path for an approving device.
- The migration and the cutoff tightening.
- The presence-key route's new refusal.
- The join refusal during a claim.

## 1. Over-block

- **Devices that approved before keep working** (kept), on the machine where they were kept.
- **A device that registered a presence key after the cutoff is refused** until it is set up by the code or a grant. This is the intended fix: the old route let any program do it.
- **Older apps** see `403 approver-required` where they used to see `409 presence-key-missing`. The flag `presenceKey` in status answers now carries `mayApprove`, so older apps hide approval buttons for a device that can't approve.
- **Removing an approving device by token now waits for the owner.** Unmarked devices are removed at once, as before.

## 2. Under-block

- **Residual: a reader of the private chat.** A program that can read the owner's private chat (Telegram Desktop on the same PC), or that talks the owner into typing the code, can become the first approver of an agent that never had one. mobile-approver-mark §3.3 states this.
- **Residual: kept devices.** A kept device was trusted before this release. It stays trusted on its machine, and it is listed to the owner.

## 3. Level-of-abstraction fit

- **One reader module** decides, and the routes only ask it.
- **The record's evaluator (2a)** checks every entry, including the first owner key's proof.
- **The claim, grant and removal** each live in their own small module, mounted by the pairing router.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — deterministic checks over enumerable inputs (signatures, record keys, device status, signed peer replies, codes); no judgment over meaning.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The limits are inherited, as stated in spec §3b:
- **The claim code:** 30 minutes, three tries, three claims per machine per day.
- **The peer deadline:** 10 seconds.
- **The live claim:** 24 hours.
- **Waiting grant requests:** at most 10.
- **Pending removals:** at most 20, each for 24 hours.

## 5. Interactions

- **Owner-record sync:**
  - Pull replies gain an `approver` field: the build marker, unvouched count and migration time.
  - The tick skips the self-add while a claim is live.
  - Machine-key entries now flow at Basic. The relay is 2b's existing one, bounded by its per-peer push interval.
- **Telegram:** the Approve and Decline handlers check for a pending removal first. The Decline toast may carry the handler's own words.
- **Joins:** refused during a claim (`409 approver-claim-live`).
- **Tests:** 20 route and e2e test files now set up approvers through `markApproverForTest`, which stands in for a kept device.

## 6. Rollback

Revert the commit. These stay behind, ignored by older builds:
- the local state file `state/mobile-approver-state.json`;
- record entries, which older builds treat as unknown keys;
- the record-only key file.

On an older build, any presence key approves again, which is the pre-3a behaviour.

## 7. Evidence

- **Unit:**
  - `tests/unit/identity-piece3a-approver-record.test.ts`: P-256 first owner key with the proof checked against the record; forged and replayed proofs; self-added machine keys only at Basic and only with the registered key; the store's add and merge; the claim's check of every machine.
  - `tests/unit/identity-piece3a-approver-claim.test.ts`, through the real device routes:
    - a lone agent's claim end to end, with the record-only key created only after the code;
    - wrong codes, a changed entry, a wrong signature, a second claim, and other unvouched devices;
    - kept devices and the presence-key refusal;
    - a grant;
    - removal with the owner's tap, and the last owner key refused;
    - the cross-machine cutoff.
  - `tests/unit/identity-piece3a-approver-ratchet.test.ts`: the one-reader ratchet, with both sides of its patterns.
- **Regression:** 2a–2d unit files (106 tests; one 2b sync test now lets the push interval pass, because machine keys are relayed at Basic), the trust-approval routes and the key-material routes.
- **Route and e2e test files** switched to `markApproverForTest` are run by Local Verify (no hand-run integration or e2e on this machine).
- **E2E lifecycle:** `tests/e2e/identity-piece3a-approver-alive.test.ts` (boot runs the migration; the approver routes answer, not 404). Local Verify runs it.
- **Live (test-agent-live):** a throwaway agent on this build (2026-11-18 11:21 PST), with real device and P-256 presence signatures over HTTP. A phone that had a key before the release is kept and signs in with Face ID. A fresh device can't register its own key (403) or mint a console ticket (403). The claim refuses with no private chat and sends nothing. The agent's token can't remove the kept phone (409). Record: `.instar/state/identity-build-144636/p3a-throwaway-proof.md` in the agent home. The private-chat code leg is proven by the route tests and at first real use.

## Second-pass review

An independent reviewer subagent read the code cold. Round 1 did not concur, with four blocking findings. All are fixed with tests:
- **A phone approved on one machine couldn't approve on another:** an owner key in the record may now be registered by the device holding it, on any machine.
- **`legacyPersonActs` was never written,** so an old Mac without Touch ID blocked every first claim: the migration now records it.
- **Removal left dead keys counted,** and there was no `revoke-key` path: the last-approver rule now counts only live keys, and approvers can sign `revoke-key`.
- **Grants listed every waiting request:** §3.4's six-digit match code, typed on the approving device, is now required, and requests are never listed.

Non-blocking fixes:
- The local override is refused for approving devices.
- The ratchet names every file that checks a P-256 signature itself.
- Sign re-checks that the record hasn't moved.
- The claim limit survives a restart.
- Dropped kept devices are announced.

Round 2 did not concur, with two more blocking findings, both in removal. Both are fixed with tests:
- **A removed phone could come back** by pairing again and registering the same key. Removed keys are now retired, refused everywhere, and shared with every machine through the record sync.
- **The last-approver rule ran only when a removal was asked for.** It is now checked again when the owner's tap or a signed revocation takes effect.

Round 3 concurred. Its smaller notes were applied before commit:
- retired keys are never evicted;
- the claim's every-machine-on-this-build check reads each machine's signed build statement (the new `approver-record` guard);
- a retired key can't claim;
- the kept-devices notice is sent whenever the migration runs.

Residual: on a multi-machine agent, a key whose device was removed on another machine still counts as live here until the next pull (at most 15 minutes).

Record of all three rounds: `.instar/state/identity-build-144636/reviews/p3a-second-pass.md` in the agent home.

## Class-Closure Declaration

**In the trace:**
- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** no self-triggered loop. Each new action fires at most once per cause, held by state that only moves one way:
  - The per-tick machine-key self-add adds once per machine, then reports present.
  - The Basic fork merge runs only on the lease holder with no split-brain, only while forked, and never after the first owner key.
  - The kept-devices notice fires once per migration, which runs once per machine and is saved on disk.
  - The dropped-devices notice fires only when the kept list shrinks, which it can do at most as many times as it has entries.
  - The removal DM is user-driven: one per removal request, with at most 20 pending.

**Also guarded here (a new class, recorded in this artifact):**
- **defectClass:** `self-granted-authority`. A principal grants itself an authority through a route that only proves it holds a key.
- **closure:** `guard`
- **citation:** `tests/unit/identity-piece3a-approver-ratchet.test.ts`
- **how-caught:** any new code that reads a device's presence key or checks a presence signature outside the approver module fails the ratchet.
