---
status: approved
parent-principle: "A Refusal Stays a Refusal — conservation of negative outcomes"
slug: codex-early-native-binding
approved: true
approved-by: "Chief of Staff delegated scope decision 71d7b22c-3cde-4f0b-8897-0a09a4b475c3; prior independent review of retained defect fixes; binding removed"
review-convergence: "2026-11-23T07:33:56.581599+00:00"
review-mode: operator-delegated-bounded-closure
full-convergence: false
finding: N80
eli16-overview: docs/specs/codex-early-native-binding.eli16.md
---

# Tell the Truth When a Telegram Message Cannot Reach Its Session

A conversation can be alive but refuse a message because the existing verified dispatch path has no usable native transcript baseline. The current duplicate cache records that failed attempt before dispatch. A second forwarding can then return success and display Delivered even though neither attempt sent anything. This increment fixes that false success and retains an honest, tracked failure.

## Authority and Scope

This increment directly serves the named standard **A Refusal Stays a Refusal — conservation of negative outcomes**: an injection refusal remains false through duplicate handling and forwarding acknowledgement, with truthful durable failure visibility. No refusal becomes a successful receipt.

Chief message `71d7b22c-3cde-4f0b-8897-0a09a4b475c3` says: “Take identity binding OUT of this increment” and “Ship only the pure defect fixes.” It authorizes the dedup contract, durable attempt-qualified failure visibility, and agent-owned follow-through through the existing CommitmentTracker, without a new review round for removing false Delivered. These retained boundaries passed the actual internal review; the previous full design did not converge. This records operator-delegated bounded closure of the narrowed scope with full-convergence false, not a clean full design review.

Native identity capture, conditional binding, hook installation parity and the delayed-predecessor question are parked in `codex-early-native-binding.parked.md` and the retained review report. Do not change any identity setter, hook reporter, initialization or migration path in this increment. No new inbox, automatic replay, lease rule, respawn authority or delivery guarantee is added. Historical unknown rows and do-not-replay tombstones remain untouched.

## Decisions

1. Insert a recent Telegram delivery dedup entry only after the existing inject operation returns success. A failed invocation must never seed a later true duplicate result. Existing successful duplicates remain suppressed. Preserve same-source suppression for possible-effect false or thrown results in a separate uncertainty receipt using the existing window, returning false rather than Delivered. Only the actual proven pre-effect refusal avoids that uncertainty receipt. No false result is evidence of no effect by itself. Keep original dispatch authorization and physical-effect handling; this feature does not itself resend any message.
2. Observe the exact ordinary Codex baseline refusal before durable prepare and physical dispatch with a synchronous invocation-local typed result. An observed wrapper calls the existing injection method once and restores its prior observation in finally, including nested calls. Preserve generic boolean callers. Do not tag the later post-prepare failure that uses similar log text or the narrow matching preRolloutBootstrap exception. No log parsing or second authority check.
3. On the typed refusal, use the exact authenticated Telegram source identity to create a durable attention record and an existing agent-owned CommitmentTracker obligation, then send an ordinary response through the existing origin-aware response path. Use conservative attempt-qualified wording on all three surfaces: this attempt stopped before sending; an earlier attempt's delivery is not established by this refusal. Do not say Delivered, queued, saved for retry, or advise resend. The forwarding HTTP route awaits the callback result and propagates explicit refused:true to its existing lifeline acknowledgement consumer, rather than acknowledging a callback still deciding whether it can dispatch. Preserve the existing response format otherwise. No message text, credentials or raw native ID in records. Use a stable namespaced source key, not a new session identity. Preserve the exact known source reference through the existing sourceConversationKey (`telegram:<topic>`) and sourceMessageId commitment fields so investigation can locate the original input; do not set sourceVerified or infer owner authority from those references. Observe actual persistence/readback and actual outbound acceptance or held result; an in-memory item or held response is not proof of delivery.
4. Use existing synchronous CommitmentTracker.record externalKey get-or-create for one active in-process obligation. Owner agent, source sentinel, one-time-action, manual verification, beacon enabled with existing cadence and caps. It asks the agent to establish readiness and report actual outcome or a supported recovery option, grants no replay or injection authority, and cannot complete merely from a binding or acknowledgement. Two concurrent handlers must read back one active obligation. Do not claim cross-process uniqueness.
5. If attention, tracking or outbound custody fails, record an attributed degradation and report which evidence is absent. A combined failure must never pretend the owner was informed or follow-through was secured. This bounded core does not guarantee eventual delivery. Tracking failure does not turn a refusal into success.

## Signal and Authority / Parent Standards

The typed refusal observes an existing exact safety invariant; it does not infer message meaning or authorize dispatch. Source-key dedup is transport mechanics. The physical-effect store, existing baseline/owner/epoch checks and origin transport remain authorities. Parent principles are verified state rather than success symbols, honest uncertainty and agent-carried follow-through. No new static judgment gate is introduced.

## Multi-machine posture

Attention retains the existing proxied `GET /attention?scope=pool` path, qualified by actual peer availability and mapping. Commitments use existing replicated reads: `GET /commitments?scope=mesh` merges local and already-stored replicas, not a live owner read. A dark replica layer can return local-only HTTP200; no replica is not evidence of no obligation. Preserve existing replica staleness and disclose missing-owner/read limits. No new replication or cross-machine execution path is added. Source identity uses the existing Telegram forum/bot namespace and exact topic/message identifiers; no credential is persisted.

## Decision points touched

- Success-only dedup insertion — invariant, enumerable-domain: a boolean false is not a successful prior dispatch.
- Exact pre-prepare observation — invariant, irreversible-consequence: only the actual before-effect branch can establish this invocation had no effect; it cannot classify historical attempts.
- Failure wording — invariant, irreversible-consequence: uncertain original outcomes must remain unknown and cannot authorize retry.
- Attention/commitment evidence — pass-through to existing stores, with actual persistence verification; no new completion or resend authority.
- Native identity and incarnation selection — untouched and parked.

## Verification Plan

Unit: failed short and long injections followed by repeated source must remain false and remain suppressed when effects are uncertain; an actual partial-effect-then-error duplicate must not repeat the effect; successful duplicate remains one injection; a later genuinely successful attempt may populate dedup. Test exact typed baseline refusal, post-prepare failure, bootstrap exception, nested observation/finally restoration. Test attempt-qualified topic/attention/commitment wording for earlier-unknown/current-refusal and never include raw text. Exercise attention persistence failure, tracking failure, outgoing held/rejected and combined failure; concurrent handlers resolve one active externalKey record.

HTTP integration: actual ingress/forward route and actual SessionManager wiring must refuse without Delivered, retain authorized attention/commitment readback, and preserve non-owner refusals. Cover both the normal server-polling and lifeline/send-only callback wiring through their shared late-bound tracker accessor.

Lifecycle: real production components in a fresh guarded fixture with the existing baseline deliberately absent must produce zero physical effects, truthful persisted failure and one existing obligation. Verify wiring integrity and real store reload. Preserve original successful dispatch and unknown-effect guard behavior. Use no live owner topic and no manual tmux replay. Any genuine user-role demo proof requires separately proposed allocation and preserves all existing transport guards.

All test execution requires exact Throughput allocation, normal HOME, private actual Node24/SQLite and ordinary shared enforcement. No test is allocated by this document. Final exact-head complete LocalVerify and any separately coordinated supported startup proof remain required before shipping claims.

## Side Effects, Awareness and Rollback

Only failure dedup, typed refusal observation, attention/tracking and response wording change. No identity or native hook changes. Add agent awareness of truthful refusal and the ban on replaying uncertainty. Revert source through normal update to roll back; leave historical delivery and tracking evidence intact. Agent acknowledgement or notice expiry is not proof of delivery.
