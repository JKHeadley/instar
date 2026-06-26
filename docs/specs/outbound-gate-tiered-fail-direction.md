---
title: "Outbound critical-path gates — fail-direction tiered by channel (operator-channel-sacred, outbound side)"
slug: "outbound-gate-tiered-fail-direction"
author: "echo"
eli16-overview: "outbound-gate-tiered-fail-direction.eli16.md"
parent-principle: "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery"
review-convergence: "2026-06-26T04:27:00.982Z"
review-iterations: 3
review-completed-at: "2026-06-26T04:27:00.982Z"
review-report: "docs/specs/reports/outbound-gate-tiered-fail-direction-convergence.md"
cross-model-review: "skipped-abbreviated"
cross-model-review-reason: "tightly-scoped single-gate fix during active load investigation; lessons-aware + adversarial + conformance gate + a confirmation round ran and caught a spoofable-leak design"
approved: true
approved-by: "echo (under Justin's standing blanket authority, topic 28130/28730 — the outbound twin of the #1274 operator-channel-sacred fix Justin directed)"
approved-basis: "standing-authorization + explicit directive (identify+integrate+apply the missing standard, convergent audit); 3 convergence rounds caught + resolved a spoofable-leak design (launderable recipientType → structural verified-operator resolution, fail-closed default) + 6 majors; ships DARK (default `always`/today's behavior) + dev-gated dryRun-first, so the operator reviews real behavior before any fleet delivery; revertible via frontmatter"
---

# Outbound critical-path gates — fail-direction tiered by channel

## Problem statement

The "Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery" standard (integrated 2026-06-25, inbound side, PR #1274) has an unaddressed OUTBOUND twin. The convergent audit (CMT-1794 + this session) found two outbound critical-path gates pulling in OPPOSITE wrong directions on an availability failure, both blind to the recipient channel:

1. **MessagingToneGate** (`src/core/MessagingToneGate.ts` `review()`): receives `context.channel` (L433) but the fail-direction decision (L460-491) NEVER consults it. Every availability failure — capacity-shed (L468-477), provider-error (L480-482, default fail-CLOSED), route-budget-timeout, unparseable-after-retry (L461-464) — HOLDS the message identically whether the recipient is the OPERATOR or an EXTERNAL party. **Confirmed live this session:** operator-bound status replies to topic 28130 were held with "did not produce a verdict within the budget" under capacity pressure, sealing the agent out of its own operator channel (worked around via the direct Telegram API). This is the OUTBOUND lockout — the mirror of the inbound bug #1274 fixed.

2. **CoherenceReviewer / CoherenceGate** — **ALREADY FIXED + SHIPPED (CMT-1794, present in v1.3.667).** Grounding (2026-06-25) confirmed `CoherenceReviewer.ts` now propagates an explicit `abstained:true` + `abstainCause` on error/timeout/unparseable (the inert `pass:true` is never trusted while abstained), and `CoherenceGate.ts` counts it as an abstain (`abstainCount`), consults `resolveCriticality`, and fails CLOSED on a high/critical-criticality abstain on an external channel (`failClosedOnCriticalAbstain`, live-revertible) — the "4th fail-closed seam." So the outbound-LEAK half (fail-open) is DONE and is NOT in this spec's scope. (`SendGateway` Stage-4 to verify-already-fail-closed during build; if a gap remains it folds in, but the confirmed live defect is the tone gate.)

So this spec is now scoped to the ONE remaining gap: **MessagingToneGate operator-channel tiering.** The principle: **availability-failure fail-direction must be TIERED BY CHANNEL.** Operator/owner channel → fail toward DELIVERY (operator-channel-sacred: an availability blip must never seal the operator out). External channel → fail CLOSED (No Silent Degradation). A genuine CONTENT verdict (real leak / B15 stop / policy block) ALWAYS blocks regardless of channel — a verdict is not a degradation.

## Proposed design (scoped to MessagingToneGate)

**Convergence (2026-06-26) corrected a spoofable-leak trap in the first draft.** The naive design keyed the deliver decision on `recipientType` — but the codebase ALREADY labels `recipientType` "launderable" (`CoherenceGate.ts:749-756`: leak-gating is "keyed on the RESOLVED external flag, never the launderable recipientType") and it DEFAULTS to `'primary-user'`, so `recipientType === 'primary-user' ? operator : external` would default every unbound/ambiguous topic to operator→DELIVER — a leak. The corrected design resolves the class STRUCTURALLY and defaults closed.

**`recipientClass: 'operator' | 'external'` is resolved at the tone-gate route from the VERIFIED topic-operator binding, never from a passed-in `recipientType`:**
- `const recipientClass = isVerifiedSoleOperatorTopic(ctx, options.topicId) ? 'operator' : 'external'` where the predicate is TRUE only when `ctx.topicOperatorStore.asVerifiedOperator(options.topicId)` returns a verified binding AND the topic is a 1:1 operator reply topic (not a multi-user/broadcast topic, not a relayed peer/threadline send, not the unbound interactive topic). The boolean DEFAULTS FALSE → `external` on ANY ambiguity (no binding, no topicId, resolution error, multi-recipient). Fail-closed is the structural default, not a fallback.
- This is DELIBERATELY a different carrier than CoherenceGate's `isExternal` (see "Why the carrier differs" below) — NOT the "same carrier" the first draft wrongly claimed.

1. **`ToneReviewContext`** gains a `recipientClass: 'operator' | 'external'` field (today it carries only `channel: string`; `channel` is the PLATFORM string `'telegram'`/`'slack'`/… — uninformative about WHO reads, which is exactly why platform-`channel` cannot be the carrier).
2. **`routes.ts:1855` call site** computes `recipientClass` once (structurally, as above) and passes it into BOTH (i) the tone context and (ii) the route-budget-timeout fail-direction at `routes.ts:1872-1874` — the SAME verified value to both, so neither seam can disagree.
3. **`MessagingToneGate.review()` availability paths ONLY** (capacity-shed L468-477, provider-error L480-482, unparseable-after-retry L461-464 — the no-verdict branches): operator → a NEW `failedOpenOperatorChannel:true` DELIVER verdict; external → keep today's fail-CLOSED hold. The tier is applied STRICTLY inside these availability branches — NEVER to a `pass:false` produced by `interpret()` (a real content/B15 BLOCK verdict), which always holds on every channel. A `failedClosed`/`capacityUnavailable` disposition is the ONLY thing convertible to deliver.
4. **The route-budget-timeout seam** (`routes.ts:1872`, the `failClosedOnExhaustion` branch that ACTUALLY held this session's operator replies) tiers identically on the same `recipientClass`. BOTH the in-gate paths AND this route seam must tier, or the lockout persists / an external message leaks on timeout.

**Why the carrier differs from CoherenceGate (consistency note — NOT a divergent bug):** CoherenceGate derives operator-vs-external from `isExternal` (`isExternalChannel`: `direct`/`cli`/`internal` are internal, else external, with an `isExternalFacing` override). On the TONE-GATE reply path the `channel` string is always the platform (`'telegram'`), so `isExternalChannel` would wrongly mark EVERY operator reply external. The verified topic-operator binding is the CORRECT operator signal on this path. The two gates use different carriers because they sit on different paths with different available signals — documented here so a reader doesn't expect `recipientType`/`isExternal` threading in the tone gate.

**Audit (load-bearing for the No-Silent-Degradation reconciliation):** the `failedOpenOperatorChannel:true` flag is a NEW `ToneReviewResult` disposition (distinct from the legacy benign `failedOpen`), wired through `logToneGateDecision` (`routes.ts:1881`) AND a `/metrics/features` counter — a deliver-on-availability-failure that isn't surfaced would BE silent degradation, defeating the reconciliation.

**CI ratchet (both the GATE and the ROUTE resolution):** (a) gate-level — given `recipientClass:'operator'` an availability failure DELIVERS, given `'external'` it HOLDS, and a real content BLOCK holds for BOTH; (b) ROUTE-level — a topic with NO verified binding resolves to `external`→HOLD, a verified 1:1 operator topic resolves to `operator`→DELIVER, and a multi-user/peer topic resolves to `external`. The absent-binding→hold case is mandatory (the load-bearing Know-Your-Principal step lives in new route glue).

## Build-time wiring preconditions (convergence confirmation, 2026-06-26)

Two precise wiring requirements the implementation MUST satisfy + test (neither is a design defect — the fail-closed default contains both):
1. **Use the LOCAL auth-bound operator record.** The store exposes `getOperator(topicId)` (not `asVerifiedOperator` — that name was illustrative). The predicate MUST read the locally auth-bound `TopicOperatorStore` record (set from an AUTHENTICATED sender), NEVER the replicated `TopicOperatorReplicatedStore` (which is explicitly never authoritative for "who is the verified operator"). A binding sourced from replication → treat as ambiguous → `external`.
2. **Define the 1:1-operator-topic signal concretely.** Grounding (2026-06-26): all Telegram topics live in ONE forum supergroup (no per-topic private-vs-group flag), and there is no per-topic membership API — but `UserManager.listUsers()` gives the agent-wide human count. CONCRETE DECISION (conservative, default-false): `recipientClass = 'operator'` requires BOTH (a) `asVerifiedOperator(topicId) != null` AND (b) the agent has **≤1 registered human user** (`listUsers().filter(non-agent).length <= 1`) — i.e. a single-operator agent where no OTHER human can read the topic. ANY multi-human agent (e.g. a shared/SageMind-style install) → `external`/fail-closed, because a topic thread there could be read by a non-operator. This covers the confirmed live case (Echo/Justin = sole operator) and fails closed everywhere a second human exists. (A finer per-topic-membership signal is a documented future refinement <!-- tracked: topic-28730 -->; the single-human gate is the safe floor, and the dark + dryRun-first rollout soaks it before any fleet delivery.)

## Reconciling with "No Silent Degradation to Brittle Fallback" (conformance finding)

The conformance gate flags that operator-channel availability-failure → deliver looks like silent degradation. It is NOT, for four structural reasons:
1. **Provider-swap runs FIRST.** The fail-direction applies ONLY after the existing retry/provider-fallback chain is exhausted (a genuine availability failure), never on a first-try blip. No-Silent-Degradation's preferred remedy (swap provider) is still attempted before any fail-direction is chosen.
2. **It is NOT silent.** A deliver-on-availability-failure is AUDITED and tagged (`failedOpenOperatorChannel: true`) + surfaced in the feature metrics, not a swallowed catch. The standard targets *silent* degradation; this is loud and observable.
3. **It is channel-SCOPED, not a brittle catch-all.** No-Silent-Degradation's "fail closed" is preserved verbatim for EXTERNAL channels (the leak risk). The deliver direction applies ONLY to the verified-operator's own private channel, where the "degraded" artifact is an unreviewed STATUS note reaching the person who already controls the agent — near-zero leak risk.
4. **It is the constitutional reconciliation of two standards.** "Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery" (shipped inbound, #1274) EXPLICITLY scopes the fail-closed rule to external channels and mandates fail-toward-delivery on the operator channel. This spec is that standard's outbound application; the two standards meet at channel-tiering. A real CONTENT verdict (leak/B15/policy) still blocks on EVERY channel — only the no-verdict (availability) case is tiered.

## Decision points touched

Modifies the fail-direction of outbound message-blocking gates — high-risk. It does NOT add a brittle blocking signal; it CORRECTS the degradation behavior of existing gates and routes the decision through ONE audited helper keyed on the VERIFIED operator (structural, not content-sniffed).

## Frontloaded Decisions

- **recipientClass source** — resolved STRUCTURALLY from the VERIFIED topic-operator binding (`asVerifiedOperator(topicId)`) + a 1:1-operator-topic check, never from the launderable `recipientType` and never from content (Know Your Principal). Frontloaded; not cheap to weaken — this is the load-bearing safety decision.
- **What counts as a "content verdict" (always-block) vs "availability failure" (tiered)** — content verdict = a usable BLOCK judgment from `interpret()` (leak/B15/policy/tone). Availability failure = no usable verdict (capacity-shed, route-budget-timeout, provider error, unparseable-after-retry). Only the latter tiers; the former always holds on every channel. Fixed taxonomy; frontloaded.
- **External default on ambiguity** — `external` → fail CLOSED, as an EXPLICIT default-false boolean (no binding / no topicId / resolution error / multi-recipient). Fixed (the safe direction for leaks).
- **Rollout posture (corrected by convergence — leak-prevention change ships dark, NOT live-default).** The `messaging.toneGate.failClosedOnExhaustion` lever extends to a tri-state (`always` = today's behavior / `tiered` = new / `never`), but the DEFAULT stays `always` (preserves today's fail-closed semantics for every existing agent, esp. operators who set it `true`). `tiered` is an EXPLICIT opt-in, dev-agent-gated + dryRun-first (dryRun logs `would-deliver-on-operator-channel` without delivering) per the Graduated Feature Rollout ladder. A classification bug must soak on a dev agent before any fleet delivery. (The coherence side already shipped its own `failClosedOnCriticalAbstain` knob — no change here.)

## Open questions

*(none)*

## Multi-machine posture
Machine-local decision per send; the verified-operator binding is already a replicated-PII store (topic-operator). No new cross-machine surface — the gate runs on whichever machine is sending.
