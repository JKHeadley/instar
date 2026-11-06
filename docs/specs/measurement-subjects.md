---
title: Measure efforts, jobs, decisions and capabilities through existing initiative and evaluation owners
slug: measurement-subjects
tier: 1
status: draft
---

# Whole efforts and non-feature subjects

The independent census now includes jobs, decisions, initiatives and model capabilities, but only rollout/ladder subjects can author an evaluated contract. Extend existing InitiativeTracker with optional measurement metadata, use the same D7 observation/evaluation ledger and existing cadence, and keep generic measurements out of the legacy feature denominator. No new registry/database/scheduler, migration of old state, activation control or promotion authority. Ordinary services continue.

## Identity and authoring

An initiative may carry measurement: MaturationEvaluationContract with required subject:{kind:effort|job|decision|capability,key:string}. The binding is inside the hashed contract, validated as a closed bounded schema, and retained with historical methods. Effort key must equal initiative.id. An initiative with measurement cannot simultaneously carry rollout or rolloutAccounting; transitions clear the old owner atomically. Existing parentProjectId is the effort/component graph, never a second parent registry. Each material component has its own initiative/contract and exact target binding. A parent's baseline never supplies a child's proof.

Create/update validate the complete resulting initiative before persistence, including null clearing. Invalid new writes fail clearly. Malformed retained metadata is an explicit invalid-contract gap, never silently treated as a missing field or allowed to crash an ordinary read. A generic ready verdict additionally requires independently corroborated baseline/current proof for every declared metric, not just passing numeric thresholds. No automatic conversion of existing initiatives or synthetic measured-ready records. Contracts require outcome/method/version/owner/baseline/outcome+quality roles; raw legacy feature contracts remain compatible.

## Independent membership and current verdicts

Extend the existing independent census collector to resolve generic bindings against its canonical effort/job/decision/capability entries, including disabled jobs and completed initiatives. Namespace keys by kind and exact origin. An initiative ID colliding with a ladder subject is an explicit owner collision; the ladder must not overwrite generic metadata or lend it feature proof. Duplicate target claims are ambiguous, never whichever one passed first. A structurally valid contract targeting an absent entry is unregistered; unavailable inventory is unknown, not a registered zero-member set. The D7 pass must receive the same inventory resolution and cannot produce ready for an unknown/unregistered/ambiguous generic target. API authoring may preserve such a declaration visibly to allow registry recovery; it cannot certify it.

Generic active/nonterminal initiatives enter the existing scorer as rung measurement. Retained completed/paused initiatives remain visible without pretending they are in the current evaluation pass. Generic rows never inflate maturation.features, feature eligible/evaluated/byStatus or feature trend totals. Expose separately scoped measurement summaries and selected-origin details on the current board. Legacy readers stay compatible. History persists exact generic binding and method versions, with existing capacity, retention and byte bounds.

## Canonical decision quality adapter

Add a null-on-failure cohort read to FeatureMetricsLedger using its sole decision_winning_grade view. Filter an explicit decisionPoint, ruleId, rung and evidenceStrength; never combine incompatible graders or reimplement grade precedence. Use actual decision timestamps in a bounded explicit window. Reuse the canonical decision-machine segment conversion used by minting. Scope graded numerators to that exact local segment; exclude known foreign machines. On multi-machine installs include unattributed legacy rows as unmatched, so missing origin metadata cannot improve the grade. On single-machine installs the canonical null segment is the local database scope. Settled right rate is right/(right+wrong), samples right+wrong, unknown/unmatched safeguard is1-(right+wrong)/all decisions for that point, samples all point decisions. A failed read produces unavailable evidence. Each zero denominator makes its metric unavailable, not a zero-quality observation; an all-unknown cohort can still show100% unmatched coverage while its settled right rate is unknown. Preserve the safeguard denominator so cherry-picking a small flattering cohort stays visible.

Optional closed adapter metadata inside the generic contract binds the cohort/window and two distinct existing metric ids. Both must be evaluated: right-rate is the outcome role with an at-least criterion, unmatched-share is the quality safeguard with an at-most criterion; both thresholds are proportions between0and1. Neither can be omitted or aliased to the other. Computed source refs include the exact binding/cohort/window/metric role so a method change cannot reuse a flattering previous series. Only decision targets, or an effort explicitly scoped to that decision point, use this adapter. Quality constraints remain authored arithmetic criteria; this adapter never claims causation or general whole-system improvement. Generic projection refs are computed from exact target/method/cohort/metric identity and register through the existing projection map; ordinary feature/ladder refs cannot be borrowed. Whole-effort coverage requires an explicit effort-target binding, not an initiative feature-rollout proof. Other job/capability quality methods use existing registered target-scoped projection callbacks; absence is honest insufficient evidence, never activity-only readiness. The existing projection owner prepares/reads numbers; no new polling loop. Batch at most64unique cohort requests into one canonical winning-view query per pass; do not scan the winning view once per subject. Limit unique cohort reads per pass and expose budget exhaustion as unavailable.

## Verification

Real initiative persistence tests for create/update/null/exclusivity/id binding and unknown fields. Independent target absence/failure/duplicate tests, disabled job coverage, parent/component isolation, canonical exact owner changes. Real D7 tests for generic evaluation with legacy feature denominators unchanged. SQLite winning-grade fixtures with right/wrong/unknown/unmatched/stronger-rule precedence, zero denominators and failed reads. Method/cohort changes break source/version history. Existing authenticated local/peer read and real AgentServer wiring, bounded history and plain labels. No evidence claim from job exit success or activity counts alone.

## Original active carrier

Missing-baseline claim/promotion enforcement, full deployment and user intelligibility remain original-run work. Generic authoring and the canonical quality adapter are implemented and delivered within this run, not a substitute for those remaining obligations.

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

<!-- tracked: CMT-001 -->

