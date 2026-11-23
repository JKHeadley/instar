# Side-Effects Review — One Answer For Several Conversation Changes

**Version / slug:** profile-confirmation-batch
**Date:** 2026-11-22
**Author:** Echo
**Second-pass reviewer:** confirm_security_adversarial; scoped implementation and artifact concurrence recorded in profile-batch-implementation-security-review.md.
**Status:** Seven signed Telegram server-protocol scenarios passed, with the failed setup and separate communication finding retained. Parent 3662 and complete exact-head Local Verify remain required; no release, clean overall conversation or runtime-health certification is claimed.

## Summary of the change

Tier 3 security-sensitive Telegram confirmation plumbing adds an ordered multi-target request and one completion, preserving the verified-owner exact native-reply yes protocol. The implementation touches request/owner-turn state, server-owned rendering, ingress and routes, the write surface, store visibility/locking/restore seams and deferred runtime fences. Awareness and the release fragment describe that bounded batch scope. Six general spec rounds plus one explicitly authorized bounded confirmation reached DESIGN=0 for the scoped fixes; the approved spec records `full-convergence:false`. The larger tier reflects atomic persistence, process restarts and paired forwarding semantics. Exact staged scope is captured in the normal decision audit; no commit or release is certified by this document alone.

## Decision-point inventory

- **Proposal construction — added:** ordered validated targets, complete server-owned effect and sibling-state baseline, per-item cross-topic field restrictions, native same-name disambiguation and exact formatter preflight.
- **Consent — passed through:** actual delivered receipt, exact yes, verified principal, current source/target audience, placement, deadline and one consumption. No model consent judgment.
- **Atomic settings — modified:** canonical multi-lock acquisition, private working state, durable detached public reads, coalesced persistence/rollback and serialized supported restore admission.
- **Runtime and transfer — modified:** separate execution epoch and durable local-acceptance version, immutable assignment/incarnation guards and owned stop-to-replacement transition.
- **Acknowledgment/reminder dispatch — modified:** synchronous single claimant, source-bound server-issued owner-turn delivery allowance, aggregate activation CAS, an uncertainty audit event and the existing DegradationReporter path. No separate delivery-repair controller is implemented by this slice.
- **Task selection — existing judgment:** the conversational agent clarifies ambiguous intent and partitions clear oversized requests; it can prepare a question, never approve it.

## 1. Over-block

An oversized complete question, ambiguous duplicate-name link, conflicting reminder union, ineligible target, stale consequence or busy lock can reject legitimate work. Give actionable size diagnostics, let the agent prepare fitting groups, and expose lock acquisition as retryable while authority remains current. A fresh verified owner correction can bypass only creation churn. Existing literal yes excludes numbered/quoted prose intentionally under the retained Chief disposition; those messages remain conversational. Current-generation/local-placement scope excludes distributed atomic batches and restart-restored consent. No new target-count cap or TTL is added.

## 2. Under-block

A syntactically valid patch must not bypass per-item CROSS_TOPIC_FIELDS, current owner or audience checks. Matching current profile alone misses changed parked recovery/breaker state; the disclosed baseline includes those siblings. Actual receipt registration must not activate an aggregate if an original has already been claimed. Epoch A-to-B-to-A and same-owner transfer episodes must invalidate stale work. Saved settings cannot certify a concrete resolved running model or successful restart. Unknown send acceptance must never become delivery, a repeated mutation or a blind duplicate success. Focused three-tier tests and the independent implementation review exercise these boundaries; the signed live matrix and complete verification remain separately required.

## 3. Level-of-abstraction fit

Existing validated profile fields, actual Telegram formatter, topic locks/flush, transfer carrier and session launch doors are reused. Deterministic identity and atomicity checks enforce the registered control protocol; they do not classify natural-language intent. The conversational agent selects useful requests/subsets inside those floors. Public store reads use the last durable image while mutation code uses private working state. No independent persistent intent store, replication controller or new framework selection flag is introduced.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

This change has a protocol authority surface: an authenticated native reply to an exact disclosed server descriptor, plus ownership/receipt/freshness invariants. It does not introduce a brittle prose detector or a model authorized to interpret yes-like text. The existing Chief3ef983bf literal-yes protocol is retained; the previously recorded textual tension with the constitution's stop-enumeration wording is not silently amended here. Failure/audit context, runtime unknown and delivery uncertainty are signals for explanation/repair, never substitute approval. Owner-turn handles authorize question delivery only, not profile application.

## 4b. Judgment-point check

No new static semantic heuristic decides competing user intentions. The agent chooses clarification, fitting groups and fresh versus unchanged reminder intent, with conservative non-mutating fallback when unclear. Full provider payload capacity is an external constraint; no arbitrary target-count policy is added. Earliest old deadline governs unchanged reminder unions, while explicit fresh proposals receive their own shown lifetime. Existing acquisition timeout is retryable operational policy, not a new consent floor. Known non-dispatch may use existing bounded transport repair; uncertain external acceptance remains spent.

## 5. Interactions

- **Shadowing:** verified first-party ingress precedes owner-turn issuance and identified control handling; legacy recovery remains separately receipt-bound. Unmatched/nonexact text retains ordinary agent delivery. Polling and lifeline consumed-control paths are covered by focused lifecycle checks; the lifeline uses a WeakMap stage receipt, preserves trusted App full-await semantics and does not wait for ordinary Telegram cold starts.
- **Double-fire:** source/inbound result reservation prevents duplicate writes; one synchronous acknowledgment claimant prevents concurrent success posts. Aggregate receipt CAS cannot retire a request already claimed by an original reply. The same actual inbound cannot mint another delivery allowance.
- **Races:** canonical locks, store admission outside topic locks, detached planning, pre-publication checks, atomic rename and durable public snapshot prevent partial/undurable visibility. Supported restore must enter before file overwrite. Boot must await initial seed durability. Exact saved snapshots stay distinct from later clears/restores. All writers, replacement/restore/clear/rollback paths and deferred process-creation seams must participate; a partial conversion is a defect.
- **Transfers:** notifyLocalWriteDurable covers every accepted live-field target, including reaffirmations; an independent acceptance version is compared under lock so a missing callback/equal timestamp cannot admit a queued stale pull. Episode checks also reject ownership moving away and back.
- **Feedback loops:** the accepted inbound has one generation-local acknowledgment claimant. On delivery failure, the implementation records an uncertainty audit event and calls the existing DegradationReporter. It does not implement or independently prove a separate delivery-repair controller, verified non-dispatch retry, or consolidated terminal notice. No failure path repeats the profile mutation or blindly reposts its success. Live proof and the normal delivery infrastructure determine what was actually visible.

## 6. External surfaces

The additive authenticated route is `POST /topic-profile/propose-batch`, requiring `X-Instar-Request: 1`. Its normal body contains `confirmIn` and `targets:[{topicId,patch}]`; pending unions instead use `remindRequestIds`. Optional `fresh`, `ownerTurnHandle` and `ownerTurnInboundId` do not supply identity or consent; the opaque allowance must match trusted source/principal/inbound context. The server renders and posts the question only to its source conversation. HTTP success gives request reference, targets and shown expiry, not proof of application. Existing single-target contracts remain supported.

Telegram native Reply and exact yes make approval phone-completable. Duplicate titles use configured-group native URLs with target-path and actual-formatter checks. Settings storage format stays compatible; new working/durable views, versions, owner-turn state and completion claims are process-local. Awareness entry `src/data/awareness/profile-confirmation-batch.md` reaches new and existing agents through the normal registry/init/update path; no new configuration default or flag migration is required. No Slack or App confirmation control is added.

## 6b. Operator-surface quality

1. **Primary action:** the question lists proposed conversation effects before its reply instruction and existing long absolute deadline. Exact actual receipt is required; no extra unregistered approval post should be composed.
2. **Human language:** names and concrete effects lead. Short request reference/Reminder ordinal are supporting context. Server-only handles, epochs and hashes are not approval text.
3. **Destructive effects:** stopping/restarting and loss of earlier recovery options are disclosed as consequences. No separate prominent delete/revoke action is introduced.
4. **Phone fit:** real formatter preflight includes the entire wrapped question and same-name native links. Oversize prompts fail before spending budget/ordinal/handle; aggregate completion falls back to truthful independent settings/runtime counts. No screenshot or actual phone-width/live tap proof is yet certified. The signed real Telegram protocol exercise passed; actual phone-width screenshots and tap proof remain unproven.

## 7. Multi-machine posture

**machine-local BY DESIGN:** pending native receipt authority, locks, owner-turn handles, completion claims and execution versions belong to the actual platform binding and local server generation. They cannot migrate as permission. Durable settings continue through the existing authenticated TopicProfileTransferCarrier path; this is not continuous replication or a distributed multi-store transaction. All batch targets must satisfy existing local placement eligibility. Current placement/episode checks fence old-holder execution and stale landing. User-visible notices use existing one-voice notification routing. Native Telegram URLs address conversations rather than local filesystem/server URLs and survive moving the process between machines.

Non-authorizing restart intent continuity is assigned next and is not labeled credential-local or solved here. No new or changed `/status`, `/health`, `/capabilities` or `/channels` verdict is claimed by this slice. Dark/unreadable placement cannot become a positive local eligibility verdict.

## 8. Rollback cost

Revert source and awareness/release changes and use the normal patch-release process. No new durable root intent envelope or persisted version field needs removal. Preserve already authorized saved profiles; rollback is not permission to reverse them. Replacing the process invalidates pending receipts and owner-turn handles; a fresh delivered question is required. The user temporarily loses batch interaction and the new visibility/fencing behavior, so root must review rollback interaction with any writes already saved. No fleet restart, profile deletion or synthetic restoration of consent is part of this plan.

## Conclusion

The bounded design supports one question and answer for several eligible conversations while separating durable settings from non-atomic runtime effects. Known residual limits include generation-bound pending requests, no distributed batch commit, no restart intent continuity, unproven Slack/App consent and no healthy destination guarantee. The implementation, scoped independent review, focused integrated checks and signed protocol matrix are recorded; parent 3662 and complete exact-head Local Verify remain required. The separate agent explanation failed and is assigned immediately next under Chief disposition b30e0d07; it is not hidden by the protocol-only PASS. The remaining restart assignment stays open. The native link callback uses the adapter's actual wire chat/thread mapping, including the separate issues group; unknown routing cannot fall back to the main group. Wrong source actors cannot reserve or consume pending requests, and a denied inbound is not later reinterpreted after a role change.

## Second-pass review (if required)

**Reviewer:** confirm_security_adversarial.
**Independent read of the artifact:** completed against the current code and corrected artifact; zero outstanding material findings within the repair scope. Full verification and live proof are not certified by that read.

The review retains the original parked-disclosure and duplicate-checkmark findings, their fixes, the trusted-App regression and its correction, source/verified-owner pre-consumption guards, native namespace link binding and independent focused checks. Those runs overlap and are not a full-suite result. The separate bounded design closure is not substituted for this implementation read.

## Evidence pointers

The approved specification and overview are docs/specs/profile-confirmation-batch.md and its ELI16 companion. Six general rounds plus Chief4143c61f-authorized bounded closure are retained with full-convergence:false. Implementation and repair review is .instar/design-feedback-private/profile-batch-implementation-security-review.md.

Actual supporting checks include 127 tests across six focused unit files, 44 HTTP tests, 24 tests across the owner-confirmation and lifeline lifecycle files, 85 store/transfer cases, 69 runtime guard/orchestrator cases, and 18 native destination/render cases. These runs overlap; they are not a sum of unique project-wide tests. The final real-store renderer fixture replaced an insufficient stub after the shared planner exposed it. The incorrect initial nonexistent-park helper attempt remains diagnostic only; the corrected parked disclosure regressions genuinely failed before the repair and then passed. Startup smoke via the supported test-as-self command passed with Telegram/lease explicitly skipped; final live proof is not substituted by that smoke. The unchanged single-batch reminder regression preserves its request ID, deadline and original receipt; ordinary lifeline forwards also retain their nonblocking timing without granting disposition authority. Normal build and typecheck passed. The signed seven-scenario Telegram protocol result is in docs/specs/reports/profile-confirmation-batch-live/, with actual runtime/source binding, verified cleanup, a preserved setup failure and the separately assigned communication failure. Complete exact-head Local Verify remains required; a protocol-only PASS does not certify the overall conversation experience. No full suite was run manually. Slack remains unproven/no-fixture; no App consent or destination-health claim is made.

## Class-Closure Declaration (display-only mirror)

```json
{"defectClass":"unbounded-self-action","closure":"n/a","reason":"This slice serves an owner-driven, receipt-bound one-shot batch and delivery allowance. It adds no autonomous approval, restart-repost, polling or repeated-repair loop. Existing orchestration remains behind its existing controls; the new guards fence its one approved effect. A failed acknowledgment emits audit/degradation signals without retrying the mutation or blindly reposting success."}
```

The normal class-closure helper writes the same declaration to the fresh instar-dev trace; the commit gate persists the machine-readable decision record. This prose mirror alone grants no closure or authority.
