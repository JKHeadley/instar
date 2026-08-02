---
audit: "full-decision-visibility-enactment"
target-pattern: "Whether the shipped decision-quality system presently gives full, reproducible visibility into every LLM judgment, its alternatives and reason, its enacted result, and later outcome evidence, while retaining real cases for prompt, input, context, and model tuning."
search-surface: "The 64-row provenance census and its ratchet; production evaluate callsites; the 47 pending rows; six wired live points and their domain stores; router correlation and annotation seams; provenance volume valves; grading throughput; current fleet telemetry; the prior accountability audit and failed universal-loop package."
standing-guard: "tests/unit/provenance-coverage-ratchet.test.ts"
blind-spot-class: "declared-census-without-enactment-or-outcome-closure"
standard-response-kind: "no-change"
standard-response-ref: "docs/STANDARDS-REGISTRY.md"
standard-response-article-id: "decision-provenance-outcome-review"
standard-response-article: "Decision Provenance & Outcome Review"
standard-response-rationale: "The existing article already requires full handed context, the decision, outcome annotation, periodic grading, and real cases; the present gap is incomplete enactment and an unproven denominator, not a missing constitutional rule."
converged: "2026-08-02T13:50:59.303Z"
rounds: "2"
standard-response-digest: "0550ee6efb4f28a7c057ad872d07a29a35a0b80614e9539b2ace02515b8a0e08"
meta-artifact-at: "2026-08-02T13:50:59.303Z"
meta-artifact-digest: "d52a67c370cb293e7e618d1b3c8a4965d7506a72dc6be49af5942af9a6e7eae1"
---

# Full decision visibility enactment audit

This is the empirical current-state audit required before another Item 12 design
attempt. It builds on `docs/audits/llm-decision-accountability.md`, which converged
on three systemic gap classes in July but explicitly did not certify that the gaps
were fixed. It also treats the round-10 convergence-failed universal-loop package
as negative design evidence, not as an approved specification.

Operator source, preserved verbatim:

> Whenever the system encounters this situation, it should record as much as it can, including the choices it was choosing between, the choice it made and WHY, and all other related context, including even a screenshot if possible. The goal should be FULL VISIBILITY INTO ALL OF THE SYSTEMS DECISIONS so that we can evaluate its decision making periodically. This also gives us benchmark scenarios FROM REAL SITUATIONS, and allows us to tune the prompts, inputs, context, and models we use moving forward. This is the standard we needs to apply everywhere.

The audit answers three bounded questions: which pending points are genuinely
blocked versus merely unenrolled, what exact outcome joins are missing at the four
live but ungraded points, and whether capture should become larger, cheaper, or
both. "All" is not treated as established merely because a registry has no empty
rows.

## Meta-insight

How it arose: The project converted a universal visibility goal into a closed-looking component registry and a generic enrollment backlog before proving that component rows were a reproducible denominator for individual production judgments or that wired decisions could rejoin their enacted and eventual outcomes.
Why prior controls missed it: The ratchet kept declared rows valid and shrink-only, while earlier convergence certified gap categories rather than implementation closure; neither control re-enumerated live callsites, distinguished blocked from merely unenrolled work, or required a correlation-preserving outcome path and lossless rich capture for every supported decision.

## Round 1

Search angles: Re-enumerated all 47 pending census entries against their production constructors and router paths; decomposed components with multiple evaluate calls into individual judgment identities; traced router correlation, durable domain identity, enactment, annotations, and evidence windows for the four wired points with no settled grades; measured decision-quality and rich-provenance volume, drops, row sizes, grading backlog, and inference ceilings from current fleet state; compared every result with the prior accountability audit, the shipped meter spec, and the convergence-failed universal-loop package.
Surface delta: The inherited surface was 64 component-level rows: 11 wired, 47 pending, and 6 exempt. The empirical surface grew to individual call identities, domain outcome carriers, evidence rules, rich-row retention, and live throughput. All 47 pending rows are accounted for, but the registry is not yet a complete or reproducible denominator because several component rows conceal multiple judgments and several stale rows name no live judgment.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| `src/data/provenanceCoverage.ts` and production evaluate callsites | The census contains 64 component-oriented rows, but at least nine named components contain multiple distinct judgments and two component keys do not match their runtime attribution. The prior failed package counted 76 evaluate invocations yet also proved that count incomplete and non-reproducible. "All decisions" therefore has no earned denominator today. | denominator-not-reproducible | deferred:docs/specs/full-decision-visibility-enactment.md |
| 28 pending router-backed callsites | Twenty-eight of the 47 pending rows already reach the shared router and have stable, identifiable callsites. They are straightforward typed enrollment work, not architecture blockers. | merely-unenrolled | deferred:docs/specs/full-decision-visibility-enactment.md |
| 9 pending aggregate or mismatched entries | Nine rows are actionable only after splitting multi-prompt components or repairing exact census/runtime identity: A2A check-in, coherence review, correction distillation, pipe-session spawn, presence review, relationship extraction, session activity, standards conformance, and tree triage. | census-repair-before-enrollment | deferred:docs/specs/full-decision-visibility-enactment.md |
| 10 blocked, dark, or stale pending entries | Ten rows need a real prerequisite: a router path, a live production owner, component decomposition, or reclassification as an exemption. They are contextual evaluation, cross-model review, external-operation consultation, standalone reflection, LLM sanitization, override detection, self-knowledge extraction, standards enrichment, task classification, and temporal coherence. | genuinely-blocked-or-stale | deferred:docs/specs/full-decision-visibility-enactment.md |
| Four live measurement-only callsites | Stop, topic-intent, goal-priority, and alignment calls all omit the router correlation callback; their domain stores preserve the decision or its effects without the quality correlation. No outcome annotation can safely rejoin them, so zero settled grades is structurally expected. | correlation-chain-broken | deferred:docs/specs/full-decision-visibility-enactment.md |
| `src/data/provenanceCoverage.ts` evidence-rule registry | The evidence ladder has no truthful independent-human-review class and the LLM-interpreter rung is dormant. Reusing deterministic ground truth or self-report would misstate subjective review strength. | evidence-taxonomy-gap | deferred:docs/specs/full-decision-visibility-enactment.md |
| Stop authority, post-verifier, and stop-event store | A domain event ID and operator correct/incorrect/unclear annotations already exist, but neither carries quality correlation; the post-verifier may also change raw continue into enacted allow. The join must persist correlation plus raw and enacted dispositions, validate operator identity and dwell, and treat later resume behavior as a bounded proxy rather than proof. | outcome-join-stop | deferred:docs/specs/full-decision-visibility-enactment.md |
| Topic-intent extraction and intent evidence store | Provider errors, malformed output, and a genuine no-signal result all collapse to an empty proposal list. Future affirmation or contradiction can grade emitted proposals, but false-negative empty results require independent retrospective review. Every attempt needs correlation and disposition, with one decision linked to its zero or many proposals. | outcome-join-topic-intent | deferred:docs/specs/full-decision-visibility-enactment.md |
| Goal-priority extraction, checkpoints, and events | Checkpoints preserve source identity and extraction data but no quality correlation. Needs-confirmation is a routing state, not an accuracy label, and later same-extractor recurrence is not independent ground truth. The join needs correlation on attempts, checkpoints, candidates, and events plus an authenticated correct/incorrect/uncertain review surface. | outcome-join-goal-priority | deferred:docs/specs/full-decision-visibility-enactment.md |
| Alignment review records | Phase 1 deliberately has no actuation, so no behavioral event can prove whether a historical snapshot verdict was right. Records preserve hashes but not enough historical content to arbitrate later. Actual LLM invocations need correlation plus a bounded local snapshot and human or independently calibrated review; cache and deterministic indeterminate paths are not decisions. | outcome-join-alignment | deferred:docs/specs/full-decision-visibility-enactment.md |
| Rich provenance budget valve and current fleet telemetry | The complete quality row survives, but after each UTC-day cap the detailed row containing context, alternatives, reason, response/error head, usage, and latency is omitted. Current measured loss is 2,750 of 12,628 decisions overall and 2,589 of 6,613 completion decisions, so 21.8 percent overall and 39.2 percent of completion lack rich provenance. | rich-context-loss | deferred:docs/specs/full-decision-visibility-enactment.md |
| Rich-row retention economics | Completion rows average about 1.55 KB. Retaining the 707 rows omitted on the recent peak day adds about 15.3 MB over 14 days; retaining all 1,207 daily rows adds about 26 MB. Storage is cheap relative to inference, so sampling or count-dropping supported decisions is the wrong control. | wrong-budget-layer | deferred:docs/specs/full-decision-visibility-enactment.md |
| Completion-verification admission and prompt path | General observation admits every outbound turn, while Codex routing suppresses the general-claim envelope because it was materially slower and more token-heavy. Many calls therefore pay LLM cost after bypassing the cheap filter without receiving the intended broader review, and the prompt duplicates clauses plus the full scrubbed message. | inference-cost-mismatch | deferred:docs/specs/full-decision-visibility-enactment.md |
| Shared and component inference ledgers | Stated monetary and token ceilings are memory-only, reset on restart, do not charge failed calls consistently, and use a fixed per-call estimate rather than actual cost. Observed daily input telemetry can exceed the nominal limit. These are operational brakes, not durable financial evidence. | cost-ceiling-not-durable | deferred:docs/specs/full-decision-visibility-enactment.md |
| Periodic grading pass and current fleet cursor | The 200-row hourly pass divides capacity evenly across five points, leaving completion volume able to outrun its 40-row share. Raising capacity to roughly 500 and making it work-conserving will control backlog, but all existing completion grades are unknown because no real outcome rule supplied evidence. Throughput cannot substitute for joins. | grading-throughput-without-ground-truth | deferred:docs/specs/full-decision-visibility-enactment.md |
| Current content envelope and artifact capture | The shipped envelope intentionally stores identity, hashes, bounded features, and at most a 300-character scrubbed head. It has no general artifact-pointer or screenshot path and cannot byte-exactly reconstruct the full handed context later. The operator's screenshot-when-possible and full-context goals are therefore not enacted. | artifact-and-reconstruction-gap | deferred:docs/specs/full-decision-visibility-enactment.md |
| Daily first-N valve, counter writes, and read window | Count caps bias rich evidence toward early UTC-day traffic; dropped-counter and quality-row write failures are swallowed; and dropped counters use day buckets while decisions use exact timestamps. A nominal 24-hour report can mix nearly two days and can understate loss. | measurement-distortion | deferred:docs/specs/full-decision-visibility-enactment.md |

New findings this round: 17

## Round 2

Search angles: Repeated the audit from the strongest contrary readings: treated each generic pending row as blocked until a production router path disproved it; treated component names as insufficient until every hidden multi-call composition was sought; attempted to derive outcomes without correlation using timestamps, hashes, event IDs, recurrence, and existing annotations; tested whether larger provenance caps, sampling, higher grading throughput, or existing bench divergence could independently satisfy the operator source; and checked whether any discovered condition escaped the denominator, enactment, outcome, retention, cost, artifact, or measurement-distortion buckets from Round 1.
Surface delta: The adversarial re-sweep changed no classification and introduced no new gap class. Every one of the 47 pending rows remained accounted for as 28 straightforward, 9 repair-first, and 10 blocked/dark/stale. Every apparent outcome shortcut was ambiguous or circular without correlation and versioned evidence. Every apparent capture shortcut either lost supported decisions or changed only grading speed. Existing benchmark divergence is a separate downstream detector concern and does not repair source-case capture.

New findings this round: 0

## Convergence status (honest)

CONVERGED after 2 rounds at the current-state gap-taxonomy and work-classification
level. The audit establishes a reproducible classification of the declared 47-row
backlog, the exact missing joins for the four live ungraded points, and the economic
direction for capture. It does not certify universal decision coverage, truthful
outcome grading, screenshot availability, or lossless rich retention as built.

The existing standing guard keeps the declared census typed, unique, and
shrink-only and makes pending work enumerable. It does not prove that the census is
the full callsite denominator or that a wired row preserves enactment and outcome
closure. The follow-on specification must add those enforcement teeth rather than
claiming this audit's convergence as feature completion.

The bounded delta is now clear: establish a callsite-level denominator; enroll the
28 straightforward points; split or identity-repair the 9 aggregate points; route,
activate, or honestly exempt the 10 blocked/stale points; preserve correlation from
decision through domain state and evidence; add truthful human-review semantics;
retain complete structural records and losslessly reconstructable local rich
artifacts without sampling; reduce unnecessary inference; make grading
work-conserving; and keep prompt, input, context, and model as four independent
tuning axes fed by real cases.
