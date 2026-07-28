# Side-Effects Review — Attribute the remaining internal LLM callers

**Version / slug:** `attribute-remaining-llm-callers`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

Completes the `llm-feature-metrics-spec` goal that "every caller gets tagged."
PR #719 labeled the two highest-volume callers (InputGuard, PresenceProxy); this
adds `attribution: { component: '<ClassName>' }` to the remaining ~33 internal
`IntelligenceProvider.evaluate()` call sites across 28 files, so
`/metrics/features` attributes nearly 100% of real calls instead of bucketing
them under `unlabeled`. Each edit adds only the attribution label to the call's
existing options object (or widens one narrow local provider type — SlackAdapter
— to carry the optional field). No prompts, models, or logic changed.

Files: CoherenceReviewer, ContextualEvaluator (×3), DiscoveryEvaluator,
ExternalOperationGate, LLMConflictResolver, MessageSentinel, MessagingToneGate,
JobReflector, PreCompactionFlush, ProjectDriftChecker, RelationshipManager (×2),
ResumeValidator, TemporalCoherenceChecker, UnjustifiedStopGate, crossModelReviewer,
TreeSynthesis, TreeTriage (×2), TopicSummarizer, SessionSummarySentinel,
TelegramAdapter, SlackAdapter, CommitmentSentinel, InputClassifier, PromptGate,
SessionActivitySentinel (×3), SessionWatchdog, StallTriageNurse, and two
server.ts wiring sites (correction-learning distill, a2a-checkin summarize).

## Decision-point inventory

- N internal `evaluate()` call sites — **modify (additive label only)** — pass
  `attribution.component`. No decision logic touched.
- `SlackAdapter.intelligence` local type — **modify** — widened opts to include
  `attribution?: { component: string }` so the label typechecks.

No block/allow surface — this is observability metadata, never gates.

## 1. Over-block
No block/allow surface — not applicable.

## 2. Under-block
No block/allow surface — not applicable. (A few genuinely non-funnel `.evaluate`
sites were deliberately NOT touched: provider-internal `inner.evaluate`, the
provider adapter, and passthrough wrappers like TopicIntentCapture whose real
call — TopicIntentExtractor — is already labeled. Mislabeling those would
*reduce* attribution accuracy.)

## 3. Level-of-abstraction fit
Correct layer — the label is set by the caller (who knows its own identity) and
read at the single funnel chokepoint, exactly as the spec designs. No new logic.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md
- [x] No — this change has no block/allow surface. Pure observability signal.

## 5. Interactions
- **Shadowing / double-fire / races:** none. Each edit only adds a property to an
  options object passed to an existing call; call count and control flow unchanged.
- **Feedback loops:** none — metrics are observe-only.

## 6. External surfaces
- `/metrics/features` now shows these ~30 systems by name instead of `unlabeled`
  (additive; no field shape change). No external systems, no persistent-state
  schema change (`feature_metrics.feature` is free-text TEXT).

## 7. Rollback cost
Pure additive code change — revert and ship a patch. No data migration, no
agent-state repair, no user-visible regression.

## Conclusion
Uniform, low-risk, additive labeling that completes the spec's attribution goal.
Build clean; 337 tests across the edited modules' suites green (additive options
didn't break any exact-match assertions). A structural lint guard against future
unlabeled callers is a sensible fast-follow (it needs an allowlist for the
legitimate non-funnel/passthrough exceptions, so it's scoped separately). Clear
to ship.

## Evidence pointers
- `tsc --noEmit` clean; `vitest run` green on MessagingToneGate, MessageSentinel,
  PromptGate, CoherenceReviewer, RelationshipManager, StallTriageNurse,
  JobReflector, CommitmentSentinel, TreeTriage, SessionActivitySentinel,
  SessionWatchdog, InputClassifier, ExternalOperationGate, ContextualEvaluator
  (2026-06-03).
