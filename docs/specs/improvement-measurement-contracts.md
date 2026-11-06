---
title: "Recorded outcome and baseline contracts on the existing maturation substrate"
slug: "improvement-measurement-contracts"
author: "echo"
tier: 1
status: draft
parent-principle: "Observability — you can't tune what you can't see"
---

# Recorded outcome and baseline contracts

## Problem

D7 already has cadence, source descriptors, thresholds and sample floors. It lacks an intended outcome, an accountable owner, an evaluation version, explicit quality safeguards and a reference to the recorded baseline. A healthy activity count must not be called improvement. These fields belong to the existing contract, not a new registry, database or scheduler.

## Design

Add optional `outcome` to MaturationEvaluationContract. Its closed validated shape is: `statement` (1..500 plain characters), `owner` (1..120), `method` (1..500), `version` (1..64 stable printable identifier), `outcomeMetricIds` and `qualityMetricIds` (each 1..16 unique existing metric IDs), and `baseline` containing `origin` (1..128) and 1..16 points. Each baseline point names an existing metric ID, an exact positive safe-integer `observedAtMs`, positive integer `descriptorVersion`, finite `value`, and integer `samples` in the existing ledger's 0..100000 range. Baseline metric IDs must equal the complete contract metric-ID set, exactly once; duplicates and extra IDs are rejected. Successful construction proves only shape, never that a meaningful outcome was chosen. Existing contract cadence and metrics remain the success criteria and review cadence.

The baseline is a retained declarative snapshot plus an exact reference, not an author-created measurement. Verification reads the existing maturation_metric_observations table by origin, feature, metric and time, checks source/ref/version/value/sample equality, rejects future evidence, and requires each baseline/current point to meet the metric's sample floor. Resolve exact/latest rows through the existing composite index; tied latest rows from different sources are ambiguous and unavailable, never selected by database order. Query the exact row rather than searching the globally capped recent-rows read, so noisy neighbors cannot erase a baseline from the comparison. A read failure, different origin, changed descriptor or a pruned/unavailable source produces an explicit unavailable/mismatch result, never a guessed match. Current evidence is the latest overall row for the same origin/feature/metric, never an older cherry-picked match. It must match the current contract source/ref and baseline descriptor version, be fresh under evidenceMaxAgeHours, and occur at or after the baseline and at or before now; missing, stale, future or temporal/source mismatch results are explicit. No write path or schema migration is introduced. Baseline retention/corroboration limits stay visible; rebaselining changes the contract hash and starts a new series, never a gain.

Add a pure read projection for the existing contract and its verified comparisons. Expose baseline, current value, sample counts, source/version, exact times and numerical delta. Do not reduce mixed quality/outcome results to an automatic global better/worse decision. Existing D7 readiness continues checking its established thresholds; the new result is evidence for accountable review, not a promotion authority. A missing outcome contract is explicit, not filled by inferring intent from counters.

Use existing Initiative parentProjectId, rolloutAccounting.ownerFeatureId and ladder composedInto for hierarchy; do not add a competing parent graph. Where ladder-owned subjects replace a contract, pass optional rung-owned outcome metadata through the same pure outcome validator and existing contract constructor. Never route dynamically generated ladder refs through the scanner's closed source-ref allowlist. Legacy ladder files and contracts remain compatible. Live file authoring must cite real observations; tests include both true matching evidence and intentionally mismatched or missing proof.

## Decision points

No ordinary service, scheduling or promotion authority changes. Optional metadata is structurally validated; malformed opted-in metadata is an invalid contract. Numerical deltas are signals, not claims of causation or quality. Current and baseline evidence remain origin-local.

## Verification

Parser tests for every field, duplicate/unknown metric IDs, nonfinite values and bounded sizes. Real SQLite exact-baseline tests including a baseline older than the 8192-row recent-read cap. Pure projection tests for absent contracts, future evidence, wrong origin, source/ref/version/value/sample mismatch, insufficient samples and missing/pruned source, quality and outcome rows. Tests must establish that readiness/ordinary-service behavior is unchanged. Existing local and pool read wiring must preserve all new evidence fields within the established payload bound before claiming delivery.

## Limits and remaining run obligations

This is the contract/evidence increment of topic 139374, not a universal coverage or deployed visual claim. Independent census joins for features, decisions, jobs, efforts and components, generic effort authoring, visual drill-down, repeated real activity and an understandable deployed view remain explicit tasks in the same authorized run. <!-- tracked: CMT-001 -->

## Rollback

Revert additive schema/parser/read code. Existing persisted JSON ignores absent metadata and the existing database is untouched. No feature activation or new loop is introduced.

## Independent design review

One focused six-lens build review found current-evidence selection/freshness needed to be precise, baseline IDs needed exact uniqueness/completeness, and ladder source validation must remain separate from scanner source allowlists. All three are incorporated above. Standards conformance checked95 standards with zero findings, no degradation, and resolved parent fit. This metadata/read increment remains Tier1, reversible and advisory; no promotion authority or runtime schema migration.

## Read surface and compatibility

The existing authenticated summary adds tiny `outcomeContracts` counts explicitly scoped to current D7 subjects; these count declarations, not verified baselines or universal inventory. `?feature=<existing-kebab-id>` adds one bounded `outcomeDetail`, including source, exact times, descriptor version, sample counts, thresholds, freshness horizon and numerical deltas. Detailed proof is bounded to32KiB; metrics remain capped at16. Default peer reads accept older peers. An explicit detail request reports an older peer without the capability as unavailable, never complete. Pool validation preserves detail, checks its origin/arithmetic/future/freshness claims, and does not cache detail for60seconds across its evidence deadline. Malformed opted-in metadata is retained as the existing contract error through both legacy rollout and accounting reconciliation, rather than stripped into apparent absence.

Adding or editing metadata changes the existing contract hash and resets its comparable series/soak. Legacy contracts without outcome metadata serialize/hash exactly as before. The descriptive outcome/owner/method are declarations, not authenticated identity grants or a verified causal interpretation. Verified means the compared numeric observations are corroborated and compatible under their recorded source/version; accountable review still judges whether the outcome and quality metrics are meaningful. This increment does not add a missing-baseline promotion floor; enforcement of the whole new standard remains in the same run. <!-- tracked: CMT-001 -->

## Frozen active-run carrier

Recorded on Echo M5 through the existing commitment registry, bound to this topic; the existing autonomous run owns reports and its original duration ceiling.

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

