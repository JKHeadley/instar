# Side-Effects Review — Local Verify peer dispatch independence

**Version / slug:** `local-verify-peer-dispatch-independence`
**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** independent agent `review_next_slot_priority` — concurred after two over-block fixes

## Summary of the change

Tier 2: the coordinator's peer dispatcher no longer requires a local verifier to be in flight. Its scheduling timer runs after the local pump has had the first chance to start work, and the existing queue, lease, pause, version, eligibility, and durable reservation checks remain in force. This lets a peer work while an unrelated full suite occupies the Studio's only suite slot. The change spans 8 source, test, spec, and release files plus this review; one approved parent spec, one independent review with two concrete findings resolved, and two commit/gate attempts (the first Local Verify run caught a missing required release-note section).

## Decision-point inventory

- `LocalVerifyService.pump()` — unchanged authority: tries local work first and schedules peer dispatch after the synchronous pump.
- `LocalVerifyService.dispatchOnce()` — modified: an idle peer may take an eligible PR when the Studio's slot is occupied by another suite.
- `LocalVerifyService.peerRun()` — unchanged authority: the peer validates the coordinator lease, matching verifier and policy, current PR head, and local capacity before accepting.
- `importRefusal()` and record validation — unchanged authority: a remote result is imported only for the exact durable attempt and lease epoch.

## 1. Over-block

The change removes a wait: it does not add a block to ordinary suites or the local queue. The local pump still places its next-slot priority claim before inspecting a foreign holder. As soon as a peer reservation is durable, the coordinator recomputes that claim from the remaining local queue; a sole remote PR releases it, while queued main or another local PR retains it. The same reconciliation runs after peer acceptance or refusal. The normal pause, merge hold, main-red hold, and remote marker decisions keep their existing effect.

## 2. Under-block

A peer can receive a PR while the Studio cannot start one. A false peer-ready result could waste an attempt, but peer acceptance rechecks its own capacity and returns `peer-busy` without counting an attempt. Lease, version, policy, head, and durable intent checks remain mandatory. Main-branch checks remain local.

## 3. Level-of-abstraction fit

The coordinator owns queue scheduling. The peer owns its own admission. Removing the coordinator's unrelated local-in-flight prerequisite changes only the scheduling layer; no second admission path or authority is introduced.

## 4. Signal vs authority compliance

The host test-slot status is a capacity signal for the coordinator, not authority to merge. The remote record remains provisional until the coordinator's existing import validation accepts it. The Studio's merge handoff and safe-merge gates remain the final authority.

## 5. Interactions

The next-slot priority claim is recalculated after a peer reservation, peer response, or closed-PR dequeue so it cannot shadow ordinary suites after the local queue empties. The timer may run after another pump; the dispatcher still serializes itself with `dispatchRunning` and rechecks queue membership, lease epoch, holds, and peer capacity after awaits. No new double-fire path was found in review.

## 6. External surfaces

An eligible PR can start earlier on an already configured peer when Studio is busy. Existing `/local-verify` queue and peer reservation data, peer HTTP routes, audit events, and merge authority remain the visible surfaces. This depends on the peer being reachable and matching verifier and policy versions; a miss leaves the PR locally queued.

## 7. Failure and rollback

If the peer is unreachable, busy, stale, or rejects the request, the existing retry and breaker rules return the PR to the local queue. Reverting this change restores the old idle-peer delay. No data migration is needed; outstanding peer attempts use the existing durable journal and bounded reclaim path.

## 8. Visibility

`GET /local-verify` already shows the queue, in-flight local run, and remote reservations. The existing peer-dispatch audit entries show the attempted handoff. No new operator surface is needed.

## 9. Multi-machine posture

Machine-local queue policy stays on the lease holder. A peer only runs a request from the current holder, with a matching verifier and policy. The fix makes the current Mini lane useful during Studio slot contention; adding the M5 remains a separate live qualification step.

## 10. Test evidence and limits

Two unit regression tests were red before the change and green after it. A follow-up regression covers a closed PR discovered during base refresh. After both priority-claim fixes, the M5 isolated checkout passed 44 peer unit tests, 4 real HTTP integration tests, and 14 production lifecycle tests. Build and all 49 lint steps passed on Studio. The M5 full run passed 52,520 unit and 4,913 integration tests on the prior head. Studio's first Local Verify run caught a missing release-note section, which was corrected. Its second run caught a timing race in the new HTTP test: the peer child started before the coordinator received the acceptance response. The test now waits for the accepted reservation it asserts; an independent second pass confirmed that the wait preserves the local-start and peer-start checks. Final exact-head full-suite and CI checks are pending. The tests cover busy-slot dispatch, main staying local, and release of a stale priority claim.

## Second-pass review

**Reviewer:** `review_next_slot_priority`
**Independent read of the artifact:** The reviewer found that a durable remote reservation could leave a stale Studio suite claim, and that a closed PR dequeued during base refresh could do the same. Both paths now reconcile the claim immediately, with tests for release when only remote work remains and retention when main is queued. The reviewer concurred with the updated diff and found no further concrete over-block, under-block, lease, or hold issue. The production E2E was assessed as meaningful wiring coverage.

The reviewer also checked the integration timing correction after Studio's second run. It waits for the exact accepted state asserted, retains separate no-local-start and one-peer-start assertions, and introduces no new issue.
