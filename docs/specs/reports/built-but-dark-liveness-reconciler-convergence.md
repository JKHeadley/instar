# Convergence report — Built-but-dark Liveness Reconciler

**Date:** 2026-05-24 · **Author:** echo · **Round:** iter-1 (internal multi-lens) · **Spec:** `docs/specs/built-but-dark-liveness-reconciler.md`

## Method

Four independent reviewers, distinct lenses, run in parallel; all findings verified against live code by a dedicated grounding reviewer before acceptance:
1. Architecture & correctness
2. Standards conformance (CLAUDE.md standards + accumulated MEMORY lessons)
3. Failure modes / edge cases / the flood requirement
4. Codebase grounding (every load-bearing claim checked at file:line)

**Limitation (must be addressed before ratification):** all reviewers were Claude-family. Per `feedback_external_crossmodel_catches_what_internal_misses`, an external GPT/Gemini/Grok round should run as the final convergence pass. Recorded as open-question #4 in the spec.

## Verdict on the iter-1 draft

**Do not approve as drafted.** The problem framing and flood-free *intent* were validated, but the design overclaimed reuse of three systems that do not hold the data it needs, and would have flooded on first run with 100+ false-positive findings — directly violating the hard requirement. The fix was a real architectural revision, not a tweak.

## Findings → resolutions

| # | Severity | Finding (verified) | Resolution in this draft |
|---|---|---|---|
| 1 | Blocking | Reconciler cannot classify its #1 dogfood target — `unjustifiedStopGate` is not a `FeatureDefinition`; `FeatureRegistry.getState/transition` refuse unknown ids. "Reuse ledger / no second store" contradicts "extend subject set." | Dedicated **`LivenessLedger`** (system-scoped, own schema/state model) for non-FeatureDefinition subjects; `FeatureRegistry` decisions reused only for the FD subjects it owns. Contradiction removed. |
| 2 | Blocking | Consent FSM has no `undiscovered→declined/disabled` edge; can't mark a never-surfaced dark subject "explained"; anti-flood keyed on `featureVersion` absent for arbitrary subjects. | Liveness-specific `disposition` state model (`baseline-accepted/acknowledged/declined/snoozed/pending/open`); re-surfacing keyed on `evidenceHash` (content hash) for versionless subjects. |
| 3 | Blocking | `CapabilityIndex` is the wrong wiring source — it *excludes* `/internal/*` (the stop-gate route is in `INTERNAL_PREFIXES`) and has no uniform enabled/wired boolean. | Dedicated **wiring snapshot**: route-table dump incl. `/internal/*` + `settings.json` + a startup **construction registry**. CapabilityIndex demoted to a hint. |
| 4 | Blocking | "Zero callers" not runtime-detectable — no per-route counters exist; degenerates to static grep. | **Honest scope** section + a new lightweight per-route **invocation counter** for opt-in routes; static reference scan elsewhere, tagged `evidenceKind: static`. No overclaim. |
| 5 | Blocking (flood) | Cold-start flood: ~128 approved specs + 16 hooks + 13 mostly-off opt-in features → 100+ "unexplained dark + new" on first run; "one digest of 100+" is still a flood; no baseline. | **Intent-modality axis** (off is a defect only for `should-be-live`) + **baseline anchor** (one-time accept of pre-existing dark). First-run target: ≤2 pushes, zero others. |
| 6 | Blocking | "Nobody decided" vs "correctly default-off opt-in" indistinguishable; opt-in features (consentTier network/self-governing) are *supposed* to be off. | `should-be-offerable` modality (derived from consentTier / opt-in) → INTENTIONALLY-OFF, never a finding. |
| 7 | Blocking | Config-sync disable (`bootstrap()`) carries no reason/actor; `DiscoveryEvent.context` optional; mandatory-reason would break boot. | Distinguish decision-disable (API requires reason) from config-sync-disable (synthetic `system` reason); `reason`/`actor`/`reasonClass` as first-class ledger fields. |
| C1 | Critical | Agent Awareness violation — `/liveness` never added to `generateClaudeMd` (a capability-surfacing feature, itself un-surfaced). | Explicit PR2 deliverable: Capabilities entry + Registry-First row + proactive trigger; `feature-delivery-completeness` will enforce it. |
| C2 | Critical | Reason-capture "the agent's responsibility, enforced by grounding discipline" = willpower (the exact anti-pattern Justin flagged). | **Structural reason-capture** (§8): API-layer mandatory reason; reconciler never assumes capture; first contact is a low-priority pull-surface "why is this off?". |
| H1 | High | Reconciler's own wiring test not mandated (fails its own thesis). | PR4 wiring-integrity test: `LivenessReconciler` constructed with non-null deps + job registered; self-listed as a subject; `guardian-pulse` heartbeat. |
| H2 | High | Per-PR test tiers inconsistent (PR3 schema + PR4 surfacing under-tested). | Per-PR tiers spelled out; semantic-correctness tests for both sides of all seven suppression layers; schema-migration idempotency e2e. |
| H3 | High | discovery.db migration-parity asserted, not specified. | PR3 names the path: idempotent `CREATE TABLE IF NOT EXISTS` in ledger self-migrating init; seeded for existing agents; `migrateConfig` existence-checked. |
| P1-E | High | Severity gate brittle — 3/13 are `safety`, ungoverned enum, non-FD subjects have no category → motivating bug would be detected then NOT pushed. | Severity from the explicit `liveness-manifest` (never inferred); dogfood gate asserts the stop-gate pushes at `critical`. |
| P1-F | High | Stale "explained" silences a real dark feature forever. | `reasonClass: conditional` + `evidenceHash` re-validation (pull-surface re-surface on code change). |
| P2-G | Medium | Acknowledge-once never-responded path undefined. | `MAX_SURFACES` cap on *surfaces* (not declines) → ages to pull-surface-only; no silent drop, no re-flood. |
| P2-H | Medium | Self-darkness — reconciler can silently die. | `lastReconciliationAt` + independent `guardian-pulse` heartbeat; self-listed subject. |
| #8/#9 | Major/Minor | Taxonomy not mutually exclusive; subjectId rename churn; DEPLOY-LAG not per-feature observable. | Precedence-ordered taxonomy + INTENTIONALLY-OFF + `expects-flow` predicate; stable subjectId + evidenceHash; DEPLOY-LAG demoted to one global advisory. |

## Residual open questions (carried into the spec)

1. Baseline trade: silent-accept vs paced baseline-review digest — **needs Justin's call**.
2. Invocation-counter scope + memory cost at scale.
3. `liveness-manifest` governance (the partial-bootstrap risk — defining "every should-be-live thing" mechanically is itself the hard problem).
4. External cross-model review before ratification.

## Status

Revised draft addresses all blocking + critical + high findings and the truthfulness-affecting P1/P2s. Remaining work before `approved: true`: Justin's call on open-question #1, and (recommended) an external cross-model round.
