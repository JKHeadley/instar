# Side-Effects Review — Feedback CI floor merge

**Version / slug:** `feedback-ci-floor-merge`  
**Date:** 2026-11-03  
**Author:** Echo  
**Second-pass reviewer:** feedback_gate_review

## Summary of the change

`scripts/safe-merge.mjs` now defers its `--auto` route until the full producer-bound Actions floor is green and then calls the immediate head-pinned merge. `FeedbackExecutorService` retries pending checks under a durable deadline and removes the obsolete native auto-merge prerequisite. The CLAUDE.md template and migration both explain the revised behavior. `GreenPrAutoMerger` treats the same deferral as backpressure, not a failed ladder attempt. Tests cover all three layers. The site delivery-checks guide explains the waiting states and restores the documentation coverage floor after the repository's recent class growth.

## Decision-point inventory

- `safe-merge --auto` — modify — pending, red, missing, and green CI classification before a merge.
- `FeedbackExecutorService` — modify — pending retry and three-hour timeout.
- `FeedbackExecutorService.refreshAvailability` — modify — native auto-merge setting no longer gates an immediate CI-floor merge.
- `GreenPrAutoMerger.recordOutcome` — modify — pending does not consume ladder attempts.

## 1. Over-block

A legitimate PR whose GitHub Actions workflow is delayed more than three hours spends a merge refusal and may eventually be held. It remains recoverable through the existing retry and hold path. The executor no longer refuses solely because native auto-merge is disabled; it uses the immediate CI-floor merge path. Wrong-producer checks refuse even if a legitimate run later arrives; the next retry can pass after the correct run appears.

## 2. Under-block

A check rerun may turn red after the final read and before the merge command. GitHub enforces its configured contexts during the command, but its configured floor can be weaker. The head pin prevents a new commit from merging; the check-state race remains a short window. No durable native auto-merge request is left armed.

## 3. Level-of-abstraction fit

The merger owns the final CI predicate and the act-time head pin. The executor owns its durable retry clock. The watcher owns its ladder classification. Each decision stays at the component that has its required state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the CI floor is a deterministic safety invariant on an irreversible merge, with producer-bound source checks; pending is a signal to the existing retry authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

The merge floor is an enumerable safety invariant: every named CI context from the pinned producer must be successful for the exact head. The retry deadline is a bounded operational policy, not a competing-signals judgment.

## 5. Interactions

The green PR watcher still recognizes historical armed requests and reconciles them. The new path produces no new armed requests. Feedback hold-label removal still precedes the safe-merge call; a pending result leaves the PR open and the watcher also defers while CI is pending.

## 6. External surfaces

`safe-merge --capabilities` now advertises `ci-floor-sync-merge` and `pending-check-deferral`. `--auto` still parses for existing callers, but its action is a synchronous verified merge. The result line returns `deferred:checks-pending` for queued or not-yet-registered checks.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The feedback row says why it is waiting. No operator action is requested while CI is merely queued. A timed-out feedback executor check goes through the existing merge-unavailable hold with one listed item. The green PR watcher retries pending checks without an executor-style hold deadline.

## 7. Multi-machine posture (Cross-Machine Coherence)

The head SHA and CI results are read from GitHub, common to all machines. The feedback row's deadline is in the existing execution store and follows its owner lease. The watcher uses its existing fenced lease and state ledger. No machine-local-only authority is added.

## 8. Rollback cost

No persistent schema migration is involved. Rolling back the script to its previous `--auto` behavior would reopen the weaker-floor merge risk for both the executor and the watcher. A safe rollback must first disable both autonomous merge paths or replace them with an immediate merge path that checks the full CI floor. Pending executor rows remain readable by an old binary, but retrying them with that binary is unsafe until its merge path is disabled.

## Conclusion

The change prevents merges based on a weaker GitHub rule and bounds delayed CI registration. The remaining read-to-merge check-state race is documented above.

## Second-pass review (if required)

**Reviewer:** feedback_gate_review

Concur with the review. The reviewer found and cleared the durable auto-arm, CI-registration, head-of-line, and rollback-description gaps after revisions. A later release-summary wording concern was corrected to say the three-hour window is per attempt and a retry precedes a hold; the reviewer reconfirmed concurrence. The final diff requires its exact-head tests and CI.

## Evidence pointers

- `tests/integration/safe-merge-no-checks-ran.test.ts`
- `tests/unit/feedback-factory/execute-service.test.ts`
- `tests/unit/green-pr-automerger.test.ts`
- `tests/e2e/feedback-execute-lifecycle.test.ts`
- `site/src/content/docs/features/feedback-delivery-checks.md`
- `upgrades/next/feedback-ci-floor-merge.md`

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: scripts/safe-merge.mjs, howCaught: the complete producer-bound CI floor is read before the head-pinned merge; pending checks return without a merge command }`.
