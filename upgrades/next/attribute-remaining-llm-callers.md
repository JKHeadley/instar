# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Per-system LLM metrics now attribute nearly every internal call.** Building on
the earlier `shed`/`realCalls` fix, this labels the remaining ~33 internal
`IntelligenceProvider.evaluate()` call sites (across 28 files — the coherence
reviewer, message/commitment/session sentinels, gates, tree/topic summarizers,
relationship + drift checkers, and two server-wired background features) with an
`attribution.component`. Previously only a handful of callers tagged themselves,
so the large majority of `/metrics/features` rows fell into the `unlabeled`
bucket and you couldn't see which system was spending. Now the spend shows up by
system name.

This is observability-only — it never gates, blocks, or alters any decision (the
label is metadata read at the single metrics funnel). Completes the
"every caller gets tagged" goal of `docs/specs/llm-feature-metrics-spec.md`.

## What to Tell Your User

Nothing to configure. The per-system LLM usage view is now far more useful: the
checks and sentinels that make AI calls show up by name instead of as one big
unlabeled lump, so it's clear which parts of the system are spending and how much.

## Summary of New Capabilities

- Attribution labels on ~30 additional internal LLM callers, so /metrics/features
  attributes close to 100% of real calls by system.

## Evidence

This is an additive labeling change, not a behavioral fix — so the relevant
evidence is that it adds attribution without changing what any caller does.
- Before: 527 of ~550 funnel rows bucketed under `unlabeled` (only ~7 callers
  passed `attribution.component`); /metrics/features couldn't attribute spend.
- After: the remaining ~32 internal `evaluate()` call sites pass
  `attribution.component`, so the rows are named by system.
- No behavior change verified: `tsc --noEmit` clean; 337 tests green across the
  edited modules' suites (MessagingToneGate, MessageSentinel, PromptGate,
  CoherenceReviewer, RelationshipManager, StallTriageNurse, JobReflector,
  CommitmentSentinel, TreeTriage, SessionActivitySentinel, SessionWatchdog,
  InputClassifier, ExternalOperationGate, ContextualEvaluator) — the additive
  `attribution` option did not break any exact-match `toHaveBeenCalledWith`
  assertion.
