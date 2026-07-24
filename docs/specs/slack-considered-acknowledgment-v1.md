---
title: "Slack considered acknowledgment v1"
slug: "slack-considered-acknowledgment-v1"
author: "instar-codey"
parent-principle: "Signal vs. Authority"
status: converging
approved: true
rollout-disposition: composed
rollout-source-pr: 1537
rollout-owner-feature: slack-organization-integration
rollout-criteria: "The existing AmbientContributionGate emits a bounded considered acknowledgment for at least one eligible message without adding a second decision authority."
rollout-evidence-type: endpoint
rollout-evidence-ref: /permissions/ambient-stats
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"considered-slack-acknowledgments","source":"feature-summary","sourceRef":"slack-decision-gate.considered-acknowledgments","direction":"at-least","threshold":1,"minSamples":1}]}'
approved-by: "operator blanket pre-approval relayed 2026-07-21"
supervision: pre-approved-build-and-merge
lessons-engaged: [P1, P2, P3, P4, P5, P19, P20]
review-convergence: "2026-07-21T09:51:04.812Z"
review-iterations: 3
review-completed-at: "2026-07-21T09:51:04.812Z"
review-report: "docs/specs/reports/slack-considered-acknowledgment-v1-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Slack considered acknowledgment v1

The `lessons-engaged` identifiers refer to the canonical principles index in [Instar Design Principles and Lessons](../INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md): build before narrating, define completion, act on observable state, preserve user intent, use infrastructure, bound loops, and keep signals separate from authority.

## Problem statement

Slack considered/ambient mode currently makes one conservative LLM-backed choice for each eligible undirected message: speak or stay silent. Sometimes a full message is intrusive while a lightweight acknowledgment is appropriate. V1 adds that middle outcome without adding another classifier, another decision point, durable state, feedback machinery, or a second outbound authority.

## Scope and proposed design

The live `AmbientContributionGate` remains the only authority for eligible undirected Slack messages. Its one existing provider call returns exactly one closed action: `speak`, `react`, or `silent`. The parser rejects missing, multiple, unknown, or malformed actions. Provider absence, timeout, error, invalid output, low confidence, missing required speak contribution, channel opt-out, and rate-limit exhaustion all deterministically produce `silent`.

The existing conservative prompt and confidence floor remain intact in purpose and posture. The schema changes from a binary `speak` field to one `action` field. `speak` still requires the model to name a concrete contribution and clear the existing confidence floor. `react` must also clear that same floor, but does not require prose because it produces no reply. V1 uses the fixed Slack reaction name `eyes`; the model cannot select an emoji or attach a label. `silent` produces no Slack API call.

The accepted provider object is exact:

| Field | Contract |
|---|---|
| `action` | Required string enum: `speak`, `react`, or `silent`. |
| `confidence` | Required finite JSON number in the closed range `[0,1]`; strings, missing values, `NaN`, and out-of-range values invalidate the result. |
| `contribution` | Required non-empty string of at most 500 characters only for `speak`; it must be absent for `react` and `silent`. |

Unknown fields, a legacy `speak` field, incompatible field combinations, multiple JSON objects, or non-object roots invalidate the complete result and therefore produce `silent`.

`SlackAdapter._handleMessage` calls `decideAction()` once for an eligible message and branches once. The binary `shouldSpeak()` name is retired so the API cannot conceal its broadened result:

- `speak`: preserve the current path—consume the existing proactive budget and process the message downstream.
- `react`: consume the existing budget, call the existing `addReaction(channelId, ts, 'eyes')` once, retain the inbound message in the existing bounded channel-history ring, and return without dispatching a conversational turn. The budget is consumed before the fire-and-forget API attempt and is never refunded or retried on Slack failure. Issuing that single attempt completes the `react` branch regardless of Slack's outcome; there is no second action.
- `silent`: retain the inbound message in the same bounded ring and return without an outbound action.

Directed messages, DMs, commands, unauthorized senders, non-opted channels, and all other Slack paths remain unchanged. Existing inbound event deduplication continues to run before this seam; reconnect redelivery cannot intentionally create a second ambient decision. The existing rate-limit check precedes the LLM call. Accepted `react` consumes the same existing proactive-action budget as `speak`, preventing a reaction-spam bypass without introducing a new counter. The implementation renames the internal `recordSpoke` primitive to reflect this broadened use, but it must not add storage or another limiter. Slack's already-reacted response is benign because `addReaction` already contains all API failures without alert, retry, or fallback-to-speak. An occasional transient failure can therefore consume budget without a visible reaction; v1 deliberately prefers that conservative lost-budget outcome over refund/retry state that could bypass the cap or duplicate an action.

## Decision points touched

| Decision point | Classification | Change |
|---|---|---|
| `AmbientContributionGate` action for one eligible undirected Slack message | `judgment-candidate` | The existing context-rich LLM arbiter gains one closed action. Deterministic floor: only an explicitly opted channel with remaining budget, parseable closed output, and confidence at or above the existing threshold can produce an action; every other path ends at `silent`. Bounded action space: `speak | react | silent`. Fallback ladder: provider result → strict parser → deterministic `silent`. |
| Slack execution of the returned action | `invariant` | Mechanical exhaustive switch over the already-authoritative result: `speak` processes, `react` invokes the existing fixed reaction primitive, `silent` returns. Unknown values are impossible by type and still default to silence at the boundary. |

## Single-decision invariant

There is exactly one semantic judgment and one result per eligible message. The adapter does not independently reinterpret message content, choose between actions, or call another model.

## Signal vs authority

This directly modifies an information-flow decision point. It complies with [Signal vs. Authority](../signal-vs-authority.md): the existing `AmbientContributionGate` remains the single context-rich authority; no regex, keyword list, threshold-only detector, or adapter branch gains semantic authority. Confidence is a required field of that authority's closed contract, and the existing threshold is its conservative execution floor; it does not semantically reclassify one action as another. The Slack adapter only executes the returned closed action. The existing `onDecision` hook continues to receive the canonical decision, and the existing bounded in-memory stats remain available; v1 adds no new logger, durable record, evidence, or action-specific product analytics.

## Security and failure semantics

The message remains untrusted delimited prompt data and keeps the existing 2,000-character bound. Model output is strict closed data, never instructions: only `action`, `confidence`, and `contribution` are accepted, and an unknown or legacy `speak` field invalidates the whole result. The fixed reaction prevents prompt-directed emoji selection, covert labels, or arbitrary Slack method calls. `react` can invoke only `reactions.add` for the original channel and timestamp already authenticated by the Slack receive path. The existing authorization and directedness checks continue to run before ambient eligibility. In v1, `eyes` means only “seen and considered,” never ownership, commitment, approval, or a future response obligation; the fixed meaning is included in the gate prompt. Recipient interpretation cannot be mechanically guaranteed, so ambient opt-in for a channel also accepts this convention; an organization where `eyes` implies ownership should leave that channel out of `enabledChannelIds`.

## Alternatives considered

A deterministic keyword heuristic was rejected because the appropriateness of acknowledgment depends on conversational context, relationship, topic, and whether humans are already handling the exchange; fixed words cannot enumerate that judgment without brittle semantic authority. A user-authored channel policy remains the opt-in floor but cannot safely choose the per-message action. A second reaction classifier was rejected because it would create two decisions for one message. A delayed queue or reaction-after-processing design was rejected because it adds state, ordering, and another lifecycle when v1 only needs an immediate closed choice. Model-selected emoji was rejected because it creates labeling and social-feedback semantics. Extending the existing single LLM enum is the smallest design that preserves context-rich authority and deterministic failure-to-silence.

All uncertainty and failures resolve to `silent`. A reaction API failure is already contained by the existing fire-and-forget `addReaction` primitive and cannot fall through into speaking or retry through another path.

## Bounds and acceptance criteria

- Exactly one `AmbientContributionGate.decideAction()` call per eligible message.
- Exactly one canonical action returned: `speak`, `react`, or `silent`.
- Exactly one execution branch; `react` never dispatches `onMessage`, and `speak` never calls `addReaction` through this branch.
- `react` uses exactly the fixed `eyes` reaction and the original message timestamp.
- Missing provider, throw, timeout, invalid JSON, unknown/multiple/missing action, low confidence, missing speak contribution, channel opt-out, or exhausted budget returns `silent`.
- Accepted `speak` and `react` consume the existing shared proactive-action budget; `silent` does not.
- Directed messages and unauthorized senders do not consult this gate.
- No new persistence, evidence model, API route, dashboard, config field, model call, queue, scheduler, or feedback loop.
- Tests cover parser closure, all three actions, exact single-call behavior, reaction execution, no reply on reaction, no reaction on speak/silent, fixed emoji, budget exhaustion, and failure-to-silence.

## V2 follow-ons

The following are named future design topics and are not implemented or stubbed in v1: action-specific analytics or logging, ordering or preference learning, expanded stats, social-feedback ingestion, organization-configurable reaction whitelists and explicit social-meaning guidance, reaction-label semantics, model-vs-deterministic comparison, learned emoji choice, persistence, outcome evidence, lost-reaction measurement/refund/retry, or calibration. <!-- tracked: WS3-V2-CONSIDERED-ACK -->

V1 does not claim those contracts and does not introduce placeholder fields for them. The existing binary ambient stats surface is not expanded into action analytics; a `react` is correctly a non-speak outcome for that legacy read. Any action-specific measurement requires its own reviewed v2 contract.

## Multi-machine posture

**Unified behavior through existing ownership.** This change adds no state. Slack inbound ownership and routing already ensure only the owning machine executes `_handleMessage` for a message, so the one decision and action occur on that owner. The existing ambient rate window remains machine-local legacy state and is not changed by v1; topic ownership prevents concurrent duplicate execution. No notices, durable records, or URLs are added.

## Rollback

Revert the schema/parser and adapter branch in a patch. There is no data migration or state repair. During rollback propagation, the only visible difference is that eligible messages return to binary speak-or-silent behavior.

## Frontloaded Decisions

1. The only actions are `speak`, `react`, and `silent`.
2. `eyes` is the sole v1 reaction; the model cannot choose it.
3. `react` uses the same confidence floor and proactive budget as `speak`.
4. Every uncertain or degraded path is `silent`.
5. One existing LLM call remains the sole semantic authority.
6. No action-specific analytics, persistence, evidence, feedback, or calibration ships in v1.
7. Budget is consumed before a reaction attempt and is not refunded; duplicate/already-reacted Slack errors remain benign under the existing primitive.
8. Ambient channel configuration documentation states that v1 may add `eyes` as a non-commitment “seen and considered” acknowledgment and that channels where this implies ownership should not opt in.

## Open questions

*(none)*
