# Side-Effects Review — Bound automatic Telegram recovery review spending

**Date:** 2026-09-09
**Author:** Echo
**Second-pass reviewer:** review_retry_mitigation
**Spec:** docs/specs/telegram-message-origin.md (approved bounded custody/recovery contract)

## Summary of the change

Current-main baseline 5ebfcedda, version 1.3.1231, remote
https://github.com/JKHeadley/instar.git, fresh instar-created worktree
fix/telegram-recovery-review-budget. Justin explicitly requested an urgent cost
mitigation and deployment in topic 69507. OriginStoreBackend owns an additive
operation recovery schedule in the existing canonical outbox. Runtime reserves
an interval before bot or browser recovery, including newly admitted memory-held
candidates. Origin audit returns count and next time. Shared scaffold awareness
and idempotent CLAUDE/AGENTS/GEMINI migration explain the behavior.

## Decision-point inventory

- Recovery selection/reservation: modified deterministic scheduling; 15-minute
  spacing before potentially paid work, transactionally shared across processes.
- Review, ownership, capacity, child claims, receipt classification: passed through
  without granting new authority or caching review approval.
- Original deadline, actual attempt ceilings and uncertainty fences: preserved.

## 1. Over-block

A queued message whose underlying fault resolves just after a failed recovery
may wait up to 15 minutes for the next attempt. This is an intentional cost
mitigation, not a claim of prompt delivery. Fresh authored operations are not
delayed by another operation's cooldown. A crash after reservation consumes the
interval even if review never ran. Lost reservation responses also spend no review.

## 2. Under-block

This bounds recovery invocations, not token counts or total currency. One review
may invoke multiple existing reviewers. A fixed operation has at most 24 automatic
recovery starts during its default six-hour original lifetime; actual transport
attempts retain their existing ceiling. Newly authored operations incur normal
review costs. The store already refuses deadlines beyond six hours; shorter
original deadlines permit fewer spaced recovery starts.
Broader startup, relay, network-deadline and stale-message delivery defects remain
tracked in topic 69507. <!-- tracked: topic-69507 -->

## 3. Level-of-abstraction fit

The canonical transactional outbox owns pacing; an in-memory timer would reset on
restarts and fail across main/Lifeline contenders. Both execution paths reserve
through the real worker. Evidence mirrors and spools cannot grant recovery.

## 4. Signal vs authority compliance

Reference: [signal vs authority](../../docs/signal-vs-authority.md).
Deterministic scheduling of an existing bounded controller does not judge message
meaning. Existing live outbound policy remains the sole content/tone authority.
No approval cache, bypass flag, inferred permission, or new semantic blocker.

## 4b. Judgment-point check

No new competing-signals judgment. The 15-minute minimum is an explicit engineering
spending bound requested by the operator; it is not a classifier of urgency or
message validity. No pattern detector acquires authority.

## 5. Interactions

Atomic reservation handles simultaneous workers. Re-admission and process reopen
preserve the row. Cooldown filters maintain fair traversal, while a second check
on reservation covers memory-held candidates and concurrent scans. Existing child
claim checks still execute after review; reservation grants no send entitlement.
Unknown or terminal children cannot reserve. Timing state never updates child
attempt counts, next transport retry times, payloads or original deadlines.

## 6. External surfaces

Existing authenticated origin audit adds optional recovery count/next time.
No credentials, message text or new endpoint is exposed. Read-only audit does not
move recovery clocks. No operator form or destructive action is added. Existing
agents receive an additive SQLite table automatically when the store opens and
shared awareness through the normal migrator; custom prose is preserved.

## 7. Multi-machine posture

Machine-local BY DESIGN: execution and pacing belong to the transport credential
owner's canonical outbox. Upgraded processes using that outbox share the interval.
Today the scheduled recovery caller is AgentServer; Lifeline boots the runtime
but does not schedule recoverHeld. Mitigation takes effect when the recovery-owner
server runs the patched version. Installing files alone does not hot-swap a
process; the existing Lifeline upgrade/restart mechanism is unchanged. Source evidence
on another machine cannot grant execution or reset the owner's clock. Existing
pool origin audit carries the added fields. This does not introduce queue transfer
or new ownership authority. No new user-facing notices or URLs are generated.

## 8. Rollback cost

Revert runtime code and publish a patch. The additive scheduling table can remain
unused by the previous release; no payloads or receipts need repair. Rolling back
restores the repeated-review risk. Queue cleanup is not part of this change.

## Conclusion

The design provides a persisted spacing bound with the existing finite deadline,
preserving live review and delivery safety. Implementation and independent review are complete. All required local
validation is green; normal repository merge and publication checks remain.

## Second-pass review

Reviewer independently inspected the final runtime/store diff, all-tier tests,
and this artifact. No code safety blocker was identified. A wording concern
about Lifeline recovery/instant package uptake was resolved by naming the actual
AgentServer recovery caller and requiring a running patched owner before claiming
activation. Due-retry tests exercise current-policy refusal and accepted delivery
under the original operation. After independently verifying the correction,
review_retry_mitigation stated: "Concur with the review." The reviewer also
verified the live class-closure grader resolves the worker ratchet.

## Evidence pointers

- Red reproduction: all three new worker tests failed because no durable recovery
  reservation existed, before implementing it.
- Worker pacing and fairness: 5 tests passed.
- Initial HTTP/runtime/boot run: 55 passed; a new boot test omitted awaiting its
  asynchronous preparation result, corrected before final validation.
- Migration and fresh-template checks: 18 passed.
- Build and full lint completed successfully. Final HTTP and production boot:
  27 tests passed. The first full run detected the required awareness addendum
  missing from the feature-delivery registry test; added it with the existing
  shared-builder pairing. The next full run found a canary test using an arbitrary
  five-second real-time poll while its scheduling timers were frozen. Replaced
  that poll with awaiting the actual worker completion Promise; all 12 canary
  tests passed, and the independent reviewer concurred that real worker, timing,
  timeout, cleanup and close coverage remains intact. The completed aggregate
  subsequently recorded 51,779 passing tests and one failed source-contract
  canary case whose real worker exceeded the parent six-second deadline under
  load. That source-contract test now freezes only the parent deadline timers;
  nested workers still execute real crypto/filesystem/permission checks, and
  the dedicated timeout case remains unchanged. All 12 canary tests passed
  under the same load and independent review concurred. A clean full run on
  the corrected tree passed: 3,344 files and 51,780 tests, zero failures. The
  containing command was interrupted during its later integration stage without
  a failed test. Resuming the unchanged standard stage commands completed with
  exit zero: integration 518 files / 4,181 tests; E2E 368 files / 3,231 tests.
  Final lint passed. Skipped cases and TODO cases retain their existing status.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`.
`guardEvidence.enforcementType: ratchet`.
`guardEvidence.citation: tests/unit/telegram-origin/recovery-review-budget.test.ts`.
`guardEvidence.howCaught`: recovery tick → paid review → pre-claim refusal formerly
returned to immediate eligibility without a debit. The transactional 15-minute
reservation precedes review, survives re-admission/restart/concurrent owners, and
settles at the immutable deadline. The ratchet asserts exactly 24 starts during
the default six-hour lifetime, zero further starts after expiry even at a week,
and independent progress for other original operations. See also the controller
inventory ratchet `tests/unit/self-action-convergence.test.ts`.
