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

## Addendum: rebase onto main (2026-11-21)

While this piece waited, main gained the home-network first phone (piece 3e, PR 3518) and moved the document
decision root into `src/server/documentDecisionRoot.ts`. The rebase keeps the design of both:

- A phone added at home stays a conversations-only owner phone; piece 3b grants it the right to approve later,
  as the 3e spec says. This piece does not change that.
- The document decision root now asks `activeOwnerPhone && mayApprove` through its dependency, and the helper no
  longer reads `presenceKey` itself, so the approver module stays the only reader (the ratchet test).
- Test updates only: two native-permissions e2e tests now expect this piece's 403 `approver-required` where they
  expected 409 for a phone with no key; the approver e2e looks for `ensureApproverMigration(mp);`, which the
  second commit of this piece introduced; the console-ticket test no longer expects a `presence-key-set` row,
  because the test marks the phone with that same key first; the device-key reader ratchet allows the two
  approval-key routes' "must differ from the device key" check, as it already allows the console route's.

Owner-phone coordination: the presence-key route keeps this piece's own change and nothing more. SEC-142 (the
first Face ID key accepted on the device key alone) is owned by the security session and will change that route
next; this rebase does not attempt it.

## Addendum: app contract review (2026-11-21)

The Apple session compared the app's screens with the server contract. The app treats every 401 as "this
device's own request signature was refused": it marks the address bad and tries another, then asks to pair again.
A bad approval-key signature on `POST /mobile/approver/first/sign` and `/revoke/sign` therefore now answers 409
`presence-invalid` with a detail. 401 stays reserved for the device signature. The grant route already answered
409. Nothing else changes; the console, desktop and permission routes keep their own answers.
- `GET /mobile/approvers` holders that are in the owner record now carry `keyId`, the id `revoke/draft` takes, so
  the app can offer Remove. A kept device has no key id and is not offered. Approvers on other computers stay a
  count (`holdersElsewhere`): the record has no names for them, and an unnamed Remove is too easy to get wrong.
  They are removed from a device on their own computer or through the owner's private-chat tap.
- The first-approver code message's Decline button carried `approver-first-ignore:<deviceId>`, which no Telegram
  tap handler accepts, so it did nothing (found by the stand-in owner chat, PR 3626). It now carries a 24-hex
  `md:d:` nonce in the form the tap router accepts, and the Decline handler ends that claim at once: the code
  stops working and nothing is granted. The message still says to ignore it if it was not you.

## Prerequisite merge repair, 2026-11-22

Tier 2 maintenance under the existing approved 3a spec: normal merge of corrected prerequisite 207df123684fa64f91262ba2ba27242399f5e792 into the existing ae2d0bb6c98cb209c6111774079f756b1abed546 head. The only textual conflict was pairing-route imports. All four approver imports and both current credential-masking imports are retained. Current stall/reclaim protections, types and server wiring match the corrected prerequisite exactly; there are no deleted paths against it. No new ceremony, native approval authority, Apple or Windows implementation was added.

Independent parent source review concurred after inspecting the actual candidate: existing approved approver behavior remains, no identity check is weakened, and no new merge regression was identified. Focused checks passed: 37 unit tests in four files (3a record, claim, ratchet and 2d fence), 42 HTTP integration tests in two files (owner presence and pairing approval), two production-wiring lifecycle tests in the existing 3a E2E file, and TypeScript checking. These are focused results, not full-suite clearance.

The first-approver private-chat/Telegram dependency remains known and held. All native ceremony, app, prerequisite, queue and release holds remain in force; this repair does not authorize full admission or release. The existing signal-versus-authority, over/under-block and multi-machine analysis above remains unchanged. Rollback is a normal revert of this merge, returning the known stale prerequisite state. One independent merge-review pass; no new design convergence rounds.

## Release 1.3.1989 prerequisite readiness

Tier 2 maintenance under the existing approved approver-record specification. Coordinator readback a894029f confirms published PR3453 head7d559beb1ef491f4c4665cb57133bad4cc35100d, published recovery head45414feb1, both open against main, and neither active. The clean isolated pr-3453-prerequisite-refresh checkout matches the published approver head. Its local branch is fix/pr3453-prerequisite-refresh-144636; the older echo/identity-piece3a local branch is stale and was not used. Canonical origin is JKHeadley/instar, and the matching Node22 database addon loads successfully.

Normally merge the published minimum-build prerequisite31d46de4fadb15198b3600a628d132f88c681fd4, which already includes current main ec9401e5b. The merge is conflict-free. Permission, trust and general routes and their existing fixtures auto-merge without a manual runtime resolution. No new authority, ceremony, security-key interpretation, delivery carrier, threshold or production activation is introduced.

The existing over-block, under-block, layer fit, signal versus authority, interactions, external-surface, multi-machine and rollback assessments remain applicable. Retain current main’s security-key and owner-presence restrictions, signed owner-record approver rights, first-claim and Decline behavior, grant and revoke signatures, last-approver protection, and the difference between device-authentication401 and invalid-presence409. Current minimum-build, restart and stall protections remain the prerequisite’s implementation. Rollback is an ordinary merge correction retaining those protections; installed state is untouched.

The known first-approver private-chat dependency remains held. This readiness refresh neither implements a stopped carrier design nor clears security-key, app, native, real-phone, owner-ceremony, prerequisite or recovery holds. In particular, including3450 locally is not evidence that it merged or that3453 may enter verification or release.

Verification uses one sequential runner with normal admission for approver record/claim/ratchet and minimum-build units, real owner-presence and pairing-approval HTTP cases, production approver lifecycle cases and TypeScript. Full suites stay with throughput under its existing holds. One scoped maintenance review and one intended normal commit; no new design rounds. Final focused results and independent concurrence follow after completion.

Final focused verification passed37unit checks,42HTTP checks and two production approver lifecycle checks (81total), followed by TypeScript with exit zero. The single sequential runner recorded each exit under normal admission. Independent reviewer /root/review_3453_readiness concurred with the staged merge and appendix: approver rights, first-claim Decline, grant/revoke signatures, last-approver protection and current main’s approval-disclosure changes remain intact. The first/revoke signature routes retain their intended409 responses.

These results establish readiness of the maintenance candidate only. Full verification and every security-key, private-chat, prerequisite, app, native and real-phone hold remain required. Publication is requested as a held replacement, not as admission or release clearance.
