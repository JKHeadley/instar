# Side-Effects Review — queued owner-admission snapshot validator

**Version / slug:** queued-owner-admission-snapshot
**Date:** 2026-11-05
**Author:** Echo, Studio (builder echo-owner-snapshot-validator for hub 136110, requested by root / topic 137342)
**Second-pass reviewer:** independent reviewer subagent; outcome recorded below

## Summary of the change

Additive, on a new branch from #2806's head dee7e76bb (which stays unchanged). The body of mobileOwnerDeviceAdmission's isCurrent closure moves into one private function, ownerAdmissionRefusal, which returns a named refusal or null. The live helper calls it with the same arguments plus its route-time person object, which is always compared when present (as before, including an undefined userId), so its signature and boolean results are unchanged. A new export, revalidateQueuedOwnerAdmissionSnapshot(pairing, {deviceId, identity}), reads the snapshot's fields once, refuses malformed or non-owner snapshots, and calls the same function. It returns a frozen {ok:true} or {ok:false, reason}. Nothing calls the new export yet. Tier 1 declared (additive, unwired, a revert removes it); the risk floor may flag authorization, and the independent review is run regardless. Size: 1 source file (~+70/-17), 1 new test file (32 tests). Effort: one build pass, one fixture correction, one review round with three findings fixed, mutation checks on three gates.

## Decision-point inventory

- Owner policy / ownerAdmissionRefusal — refactor — the same checks the live isCurrent closure made, now named and with a reason per refusal.
- Live owner admission / mobileOwnerDeviceAdmission — pass-through — same signature, same results, same route-time person check.
- Queued snapshot / revalidateQueuedOwnerAdmissionSnapshot — add — shape check, owner-role check, then the shared policy. No Request, no grantVersion, no route-time baseline.

## 1. Over-block

A queued owner request is refused if anything about the phone's access changed after it was queued: key rotation, person reassignment, a rename of the owner profile that stops it qualifying, pairing or native turned off even briefly at execution time, or the key ledger not yet loaded right after boot. The ledger-not-loaded case is the one most likely to hit a legitimate request right after restart; root's executor should run after the ledger is loaded, or retry the queued intent rather than drop it. These are the same invariants the live helper already enforces, so no new over-block class is introduced.

## 2. Under-block

The validator cannot tell a real admission from a forged one with matching current values. Anyone who can write a snapshot naming the current device, key hash and owner would pass. That is by design and stated in the name and doc comment: provenance is the caller's job (root's decrypted, machine-signed sealed intent). It does not check how old the snapshot is; age limits belong to root's queue policy. It does not prove the original request's content (what action was queued) — only that the admitting phone is still a current owner.

## 3. Level-of-abstraction fit

The policy lives next to the live helper in the one module that owns owner-phone authority, so there is one source of truth. Sealed-queue provenance and expiry stay in root's executor, which has the signing and sealing context. This module has no queue knowledge.

## 4. Signal vs authority compliance

Required reference: [Signal versus authority](../../docs/signal-vs-authority.md).
Deterministic security invariants over structured state (signature-derived key hash, registered device, signed revocation ledger, people registry, feature switches). No text heuristic. It is the same authority as the live helper with a second entry point, not a new parallel gate.

## 4b. Judgment-point check

No competing-signals judgment. Every refusal is a fact about current state.

## 5. Interactions

- Shadowing: none; the live helper's checks all still must pass, and its extra route-time person check is passed as an object and always compared (tested, including an undefined userId).
- Double-fire: pure read; it writes nothing, so repeated calls are safe (tested).
- Races: the snapshot is read once into locals, so a getter cannot change the device between checks (tested). Current state is read at call time; a change after the call returns is the caller's to recheck, as with isCurrent.
- Cleanup: none needed.

## 6. External surfaces

No route, no HTTP surface, no config, no schema, no stored data. One new exported function and three exported types. The live route behaviour is unchanged (existing helper tests, Slack-from-app and holder-proxy unit tests pass unchanged).

## 6b. Operator-surface quality

No operator surface. Nothing to tap or read.

## 7. Multi-machine posture

**machine-local BY DESIGN.** It reads this machine's pairing, device, ledger and people stores, which is where the phone's admission was made and where root's queued intent executes. If root ever runs a queued intent on a different machine than the one that admitted it, it must call this on the machine whose device registry holds that phone; that routing is root's.

## 8. Rollback cost

Revert the branch. No migration, no data. The live helper returns to the inline closure with identical behaviour.

## Conclusion

Built and tested. One authority: both entry points delegate to ownerAdmissionRefusal, pinned by a source test that each current-state read appears exactly once and neither export reads the stores itself, plus a behavioural parity table where the live helper and the validator refuse every same change. Results on this branch at commit time: 70 tests pass across tests/unit/queued-owner-admission-snapshot.test.ts (32), tests/unit/mobile-owner-device-admission.test.ts (15, unchanged), tests/unit/mobile-slack-from-app.test.ts and tests/unit/mobile-slack-holder-proxy.test.ts; tsc --noEmit clean. Mutation checks, run by hand and not kept in the repo: removing the ledger revocation check and the profile check made 7 tests fail across both unit files; removing the route-time person clause made 2 fail. The holder-proxy integration test was started but sat behind other sessions' suite runs and is not claimed here; the live route code it covers is unchanged. Full suite runs at the PR gate when root takes the patch.

## Second-pass review (if required)

Independent reviewer subagent, round 1: "Concern raised" with three items. (1) The live helper skipped its route-time person check if that userId were undefined, which is not strictly the old behaviour: fixed by passing the person object and always comparing when present. (2) No test covered that check: added two tests (different user, undefined userId); a mutation removing the clause fails them. (3) This artifact claimed evidence it did not point to: rewritten above with the real results and an explicit note on what is not claimed. The reviewer found the validator itself sound: each field read once and frozen, '' and non-string fields refused, any non-owner role refused, extra or inherited fields only feed values that current state then checks, and every gate tested on both sides with live-helper parity. Round 2 (re-review of the fixes): "Concur with the review." The reviewer confirmed the live helper result is identical to dee7e76bb for every input (the route person is never null there, so the comparison always runs), the queued path checks only the frozen snapshot, and this artifact claims nothing beyond the code and tests. Noted, not a blocker: the source-pin test matches source text, so a reformat of that call line would need the test updated.

## Evidence pointers

- tests/unit/queued-owner-admission-snapshot.test.ts — new; both sides of every gate, live-helper parity, route-time person check, single-authority source pin.
- tests/unit/mobile-owner-device-admission.test.ts — existing, unchanged, passing.
