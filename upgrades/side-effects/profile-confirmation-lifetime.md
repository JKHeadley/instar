# Side-Effects Review — Longer-Lived Conversation Change Questions

**Version / slug:** profile-confirmation-lifetime
**Date:** 2026-11-22
**Author:** Echo
**Second-pass reviewer:** Independent confirm_security_adversarial reviewer; scoped concurrence after correcting the name-cache finding.

## Summary of the change

Security-sensitive confirmation plumbing retains exact native-reply yes from the verified owner. Identified requests receive an immutable, displayed deadline, defaulting to 24 hours. Each delivery callback captures its own request and attempt. The locked profile mutation constructs and verifies one immutable plan, then checks authority immediately before publishing the new record. A saved outcome is preserved before later callbacks. Deferred runtime operations carry an optional server-owned ownership guard through the actual process-launch boundary. Existing input delivery and Codex baseline authority are unchanged.

## Decision-point inventory

Delivery receipt validation, attempt ordering, deadline validity, legacy recovery receipt binding, locked write planning, saved-outcome recording and deferred process ownership checks are modified. Owner identity, exact-yes consent and native platform receipt provenance remain existing authority. Conversational recovery context explains uncertainty but cannot authorize a change. No model judges consent.

## 1. Over-block

Invalid receipts, changed ownership or an expired deadline refuse the action. The guard is optional for unrelated existing session operations. A request keeps its original deadline across reminders. The default day-long duration is a configurable product choice, not a measured universal fit.

## 2. Under-block

Native reply IDs must be positive safe integers. Late delivery cannot revive an expired or consumed request. Old send completions cannot clear a different request's delivery failure. Legacy recovery requires its current delivered receipt and unchanged parked profile version. Ownership is checked under the store lock and again at delayed destructive runtime boundaries.

## 3. Level-of-abstraction fit

Deterministic checks enforce identity, receipt, immutable request and ownership boundaries. Human intent beyond the exact control reply remains conversational clarification. A diagnostic failure summary is not a pending grant.

## 4. Signal vs authority compliance

Audit failures, delivery summaries and model context are signals only. The same authenticated owner and exact displayed change remain necessary. A server-owned closure carries runtime eligibility; no client JSON field can supply it. Saved settings do not certify that a restart ran.

## 4b. Judgment-point check

The structural checks are protocol and authority floors, not natural-language classifiers. No semantic affirmative matcher is introduced. A conversational agent may explain an interrupted request and inspect current state, but must obtain a fresh valid question where authority is absent.

## 5. Interactions

Existing source and destination ownership placement, shadow/live regime, profile-store lock and runtime orchestrator remain authoritative. The write plan uses one under-lock state. Later audit or acknowledgment failure preserves the committed result and does not repeat mutation. A process launch paused in asynchronous preparation checks ownership again before creating the process. Existing pending input custody, baseline discovery and replay semantics are not changed.

## 6. External surfaces

Telegram questions show deadline and reminder ordinal. The proposal API returns expiresAt and distinguishes a late inactive delivery from a transport failure. Existing agents receive the awareness document through normal update. The optional configuration field needs no persisted default migration because absence uses the shared runtime default.

## 6b. Operator-surface quality

Questions use conversation names and explain effects. Failure context must not claim that an uncertain operation did not happen. Audit fallback is synchronous, metadata-only, and bounded to one append retry; it does not retry a profile write. No raw user text or private proposal patch is emitted by that fallback. Batch requests, one-line completion and restart-safe reposting remain explicit next-slice work.

## 7. Multi-machine posture

Profile storage and its existing replication are unchanged. Pending questions and delivery summaries remain process-local and cannot be restored as consent. The diagnostic manager accepts explicit source-removal facts, but the production Telegram name cache is not a deletion registry and is not wired as one; no production deletion-detection claim is made. Ownership transfer invalidates deferred runtime authority. An acknowledgment failure can leave runtime outcome unknown; recovery must inspect actual saved settings and session state rather than replay an old approval.

## 8. Rollback cost

Revert this source change and rebuild through the normal release path. Optional configuration is harmless to older code. Existing saved profiles must not be reverted as part of rollback. Pending questions need fresh delivery after restart. No fleet restart or data deletion is required by this development change.

## Conclusion

The spec has an operator-authorized bounded closure for two named fixes, not full convergence. The independent implementation review concurs after the cache-based blocker was removed. Fresh signed live proof and the normal full verification queue remain outstanding. This artifact does not certify release readiness.

## Second-pass review (if required)

Concur with the review. Independent security review found one material issue: a cached-name miss was being treated as source deletion. The production callback was removed, and the optional explicit-removal hook is diagnostic-only. The reviewer reported zero remaining material findings and independently ran the unknown-existence receipt regression (one passed, 37 skipped). The private full review is retained in .instar/design-feedback-private/lifetime-implementation-security-review.md. This is scoped implementation concurrence, not full spec convergence or release certification.

## Evidence pointers

The spec and bounded report are docs/specs/profile-confirmation-lifetime.md and docs/specs/reports/profile-confirmation-lifetime-convergence.md. Targeted HTTP tests passed 37 cases; production-composition lifecycle tests passed 12 cases. Focused unit evidence includes real paused launch ownership changes, under-lock plan races, callback ordering and audit fallback. Full suites are delegated to the normal Local Verify owner.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. `defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot owner-driven confirmation; no self-triggered loop`. Only the verified owner native exact-yes reply consumes the immutable request. Audit retry is bounded to one append and never retries the user action. No automatic reminder or restart recovery controller is introduced.

## First Live Matrix And Forum-Anchor Amendment

The first real Telegram matrix on source4006b886 produced four passing scenarios and two failing scenarios; its signed artifact is retained at docs/specs/reports/profile-confirmation-lifetime-live/first-failed.json. An exact owner reply after492seconds and real native compaction changed only its target; two questions resolved separately. Restart invalidated the old receipt, but a manual fresh question timed out with transport acceptance unknown. No receipt was registered for that attempt. The following plain forum yes carried the topic-creation service anchor, and the diagnostic helper incorrectly treated that positive number as question identification. It omitted the failure explanation; no setting applied.

The amendment recognizes only an anchor exactly equal to the current numeric source topic as a forum service anchor, and only for non-authorizing failure context. Other positive reply IDs remain excluded from that diagnostic branch. Verified owner, exact literal yes and forwarding exclusions remain. Receipt registration, request selection and mutation authority are unchanged. Unit and real polling-composition fixtures reproduce the gap before the fix. A fresh signed live matrix is required for the amended candidate; the earlier artifact remains FAIL. Slack is explicitly unproven/no-fixture under Chief1ab4c33e, with fixture card wc_eeaa5fe5cfe7c94f. The Telegram-only control introduces no App confirmation flow.

Concur with the review. Independent security reviewer inspected this narrow amendment and addendum, reported zero material findings, and independently passed the selected unit case (one passed, 38 skipped) and selected polling lifecycle case (one passed, 11 skipped). The complete focused files passed 39 unit cases and 12 lifecycle cases in the author’s runs. The private amendment review is .instar/design-feedback-private/lifetime-forum-anchor-amendment-security-review.md. Fresh live proof remains required.

## Final Author Live Evidence

The corrected source ded7a23e has a signed seven-scenario Telegram PASS, retained beside the original signed FAIL. Its signature covers build hashes, actual message IDs, runtime qualifications and cleanup. The clean unbound reply's actual message file and file-read tool result verify the diagnostic data flow; it contains no failed target or request disclosure. The actual conversational agent checked C's unchanged setting and issued a registered fresh question before new native consent. All three target writes occurred once; the source stayed unchanged.

The artifact discloses the unsuccessful global-proxy trial and excludes the initial native-ABI-degraded phase. The qualified isolated runtime booted with normal Stage B and relay storage, and used the existing HTTP1 dispatcher compatibility fallback for real connection-failure testing. The source checkout's native dependency was restored after the automatic native healer changed it during the earlier trial. No product source or security floor was changed for that repair. All owned test processes and browser are closed.

This is author-observed interaction evidence with a verified signature; independent proof verification and complete exact-head Local Verify remain outstanding. Slack is unproven/no-fixture, and the parent dependency remains. It is not a deployment claim or full design convergence.
