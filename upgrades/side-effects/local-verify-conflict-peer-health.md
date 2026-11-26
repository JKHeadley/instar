# Side-Effects Review — peer breaker and PR merge conflicts

**Version / slug:** `local-verify-conflict-peer-health`
**Date:** `2026-11-01`
**Author:** Echo
**Second-pass reviewer:** `/root/manual_update_restart_review`

## Summary of the change

The coordinator currently counts every received peer `outcome:error` as a peer health failure. PR #2516 returned two `errorStep: conflict` records from M5 on 2026-11-01, raising M5's `consecutiveFailures` to two even though the conflict was between the PR and main. The next such conflict would have disabled an otherwise healthy peer for 30 minutes. This change exempts only `errorStep: conflict` from the breaker count. The record is still not imported as green; the bounded attempt is spent and the PR remains in the existing retry path. Tier 1 is appropriate because the behavior is narrow, reversible, and has no schema, endpoint, config, or merge-authority change.

## Decision-point inventory

- `LocalVerifyService.pollPeers`: after validating the exact attempted record, classify `errorStep: conflict` as a PR input problem and abandon the reservation without calling `peerFailure`.
- All other peer error records remain peer-attributable and increment the breaker, including `npm-ci` and preflight failures.
- The existing queue still bounds remote attempts at two; after that the PR is local-only. The conflict cannot produce a success record or authorize merge.

## 1. Over-block

The PR itself remains blocked by its merge conflict. A peer with real faults could avoid one breaker increment if it happens to return a conflict record, but that record must match the dispatched PR, head, and base, and the coordinator still limits attempts. Other transport and execution failures still open the breaker after three in a row.

## 2. Under-block

The exemption does not make a broken peer healthy after failures: it leaves the existing failure count unchanged. A later peer-attributable failure can still open the breaker. A conflict caused by the current PR/base pair is verified again after its head or base changes under the existing queue rules.

## 3. Level-of-abstraction fit

The coordinator owns peer health and already receives the validated record's `errorStep`. One branch in that existing decision point is sufficient; no new scheduler, health store, or retry mechanism is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Peer health is a scheduling signal. It does not grant a green record. The verifier's exact-head record and safe-merge predicate remain the only merge authority.

## 4b. Judgment-point check

The classifier uses the exact `conflict` step emitted by `git merge-tree`; it does not infer health from arbitrary error text. Unknown error steps continue to count as peer failures.

## 5. Interactions

- **Shadowing:** The per-entry two-attempt bound still moves a repeatedly conflicted PR to local verification.
- **Double-fire:** Repeated polling of one result is guarded by the remote marker; abandoning it removes the marker before another poll.
- **Races:** A base refresh can make a conflict disappear on a later attempt. The coordinator's current-base refresh and head pin remain in force.
- **Feedback loops:** A PR conflict no longer raises a peer-breaker alert; real peer failures still do.

## 6. External surfaces

`GET /local-verify` continues to report `consecutiveFailures` and `healthy` with the existing schema. No migration or configuration update is required.

## 7. Multi-machine posture

The classification runs only on the lease-holding coordinator after `importRefusal` validates the attempt, peer identity, head, base, verifier version, policy hash, and lease epoch. Peers remain unable to authorize merges.

## 8. Rollback cost

Revert the branch and publish another release. No stored state is rewritten; the previous behavior resumes for future peer results.

## Conclusion

This preserves healthy peer capacity when a PR has a deterministic merge conflict and leaves all other breaker and merge checks intact. Ship after the required test tiers.

## Second-pass review

**Reviewer:** `/root/manual_update_restart_review`

Independent review concurred with no P1 or P2 finding. The reviewer checked the `git merge-tree` conflict origin, validation before classification, bounded retries, and that an error record cannot authorize merge. The reviewer suggested preserving a prior nonzero failure count through a conflict; the corresponding unit case was added afterward. The reviewer did not run tests.

## Evidence pointers

- Studio audit on 2026-11-01: PR #2516 produced two M5 `peer-record-error` events with `errorStep: conflict`, followed by local `errorStep: conflict`; `/local-verify` showed M5 `consecutiveFailures: 2` while status was healthy and the slot free.
- Coordinator unit test: conflict records spend two attempts without breaker failures; an `npm-ci` record increments failures.
- Existing authenticated HTTP integration and production lifecycle tests exercise the peer route and service wiring; exact results to be recorded before push.
