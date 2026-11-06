---
title: Evidence required for managed maturation moves
slug: measurement-evidence-floor
author: Echo
tier: 2
review-convergence: "2026-11-06T05:42:30.461Z"
review-iterations: 3
review-completed-at: "2026-11-06T05:42:30.461Z"
review-report: "docs/specs/reports/measurement-evidence-floor-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Evidence required for managed maturation moves

## Problem statement

Topic139374 requires missing evidence to hold promotion and unsupported improvement claims while ordinary services continue. The recurring feature review already withholds recommendations under that instruction. The existing /maturation/moves authority still accepts a threshold/soak-ready feature without a recorded outcome baseline. Generic measurement readiness now checks baseline proof, but legacy feature readiness intentionally retains its old policy. This is the remaining managed-move enforcement gap, not permission to create a second promotion authority or an outbound text censor.

## Proposed design

Extend the existing MaturationLadderService.applyMove floor, using D7.maturationOutcomeForContract on the exact current ladder-owned target contract. Re-read live configuration and the current registry-derived target at the start of each move; do not authorize from the 30-second view cache, a previous D7 pass's contract, a request-supplied boolean, a peer's proof or a parent/component's evidence. Preserve the existing hash/soak, development-agent, sensitive/coherence-critical, expected-old-config and verified-write floors. No new scheduler, database, registry, generic activation path, config flag or bypass switch.

A managed move requires a valid declared outcome contract, exact locally corroborated baseline and current observations for every metric, sufficient samples, current freshness, no future timestamps/source ambiguity, exact declared-contract/source/descriptor identity and current criteria met. The owner reads the raw ledger using the existing exact indexed observation reader, with at most16metrics and32observation lookups. Missing D7, owner collision, unreadable evidence or thrown reads returns an explicit evidence-unavailable refusal before a move-intent audit or config write. No evidence is synthesized or backdated. Unknown remains unknown. The request's reason/opinions retain the accountable model's semantic decision; numeric proof never certifies causation or semantic improvement. Observation corroboration proves exact source/ref/descriptor identity; a free-text method/version label alone is not evidence of which code produced a row. Require the current immutable contract archive/hash for move proof, preserve history boundaries, and disclose that method semantics remain accountable review. Reusing identical source descriptors across a semantic method change cannot itself certify methodological equivalence.

Resolve the canonical current subject owner through the existing independent owner collector. The supplied contract must match the exact current ladder-owned target hash, with no generic/ladder owner collision, duplicate owner or absent subject. Generic declarations reserve their owner id before validating optional target metadata; malformed generic metadata cannot be overwritten by ladder precedence. This collector repair is reproduced by three failing-then-passing integration cases on runtime PR2847. Duplicate ladder subjects are already rejected by parseLadderRegistry (subject-collides), tested in MaturationLadder.test.ts “checks composed parents and colliding subjects”; never construct a usable owner map from a registry rejected by that parser. D7.maturationOutcomeForContract alone proves observations against a supplied definition and is not an ownership certificate. Unknown owner resolution refuses a move.

Use the already-shipped MaturationOutcome projection for proof. Add a bounded evidence read dependency to the ladder rather than importing the ledger or crossing the HTTP boundary. The production AgentServer wires the same D7 instance; tests must exercise that actual wiring. Reconfirm the exact target/contract and expected config immediately before writes; all proof and mutation remain synchronous, without network awaits between check and act. A write failure preserves the existing verified-write behavior.

Preserve the existing threshold/soak state for DTO compatibility. Add separate promotionEligibility:{state:eligible|held|unknown|not-applicable,reason,checkedAtMs}, with explicit counts separate from historical threshold states. Missing fields from an older peer are unknown, never eligible. Expose a plain reason in the move refusal. A feature may still show numeric thresholds and soak passing while its managed move is evidence-held; headline counts and recurring-review consumers must use promotionEligibility, never infer eligibility from the old state alone. Render the existing owner-selected method/history detail to explain what is missing. Do not relabel historical D7 evaluations, reset soak, migrate records or rewrite old conclusions. Historical threshold-ready is explicitly distinct from present promotion eligibility.

Every managed start, including a dry-run start, requires the same evidence floor. The current registry has no separately enforced side-effect-free start type, so a start exemption would create an activation loophole. Collection of real evidence may require a separately authorized drill or existing explicit configuration action; this increment creates no activation authority and no claim that it controls every raw config write. No unknown or empty baseline becomes a bootstrap allowance.

## Decision points touched

1. **invariant** — existing managed-move evidence precondition: exact typed contract, local corroborated observations, freshness, finite values/sample floors and declared numerical criteria. These establish whether proof exists for this exact subject/method; they do not judge semantic improvement. The existing /maturation/moves authority alone applies the floor.
2. **judgment-candidate** — whether the feature should advance when evidence exists remains the existing accountable recurring-review model with reason and opinions, within current sensitivity/development/coherence/soak/config floors. Conservative default is no move; unavailable or conflicting evidence ends at the deterministic no-write rung. The proof reader cannot create a recommendation.
3. **judgment-candidate** — improvement claims remain the existing conversational/review authority with baseline/method/sample/freshness signals and the explicit no-unsupported-claims instruction. No regex/text blocker, new outbound authority or universal semantic-enforcement claim. The review writes its reasons and corrective work to the existing report/commitment records.

## Multi-machine posture

Unified operator view through the existing selected-origin pool board. Each managed configuration move must read the executing machine's own current contract and ledger; another machine's ready state cannot authorize it. Historical observations retain origin identity and are proxied on read through existing authenticated peer routes, never copied or treated as local proof. No new notices; the existing lease-held recurring reviewer remains the one report source. Credentials and physical process control remain with the existing owners, with no new replication or locality exception.

List views share a64-observation-read total budget, memoized by exact origin/subject/contract for that read, and evaluate proof only for threshold-ready or startable candidates. Count all candidates before admission; omitted candidates have unknown eligibility with an explicit budget reason and cannot inflate eligible counts. The move path always performs its own fresh bounded proof read and never authorizes from that list admission/cache. No list-view omission disables ordinary services.

## Frontloaded Decisions

- Every managed start pays the evidence floor; no implied safe-start exemption.
- Preserve threshold state; add separate promotion eligibility and conservative old-peer handling.
- Canonical owner resolution precedes proof; supplied-contract corroboration alone is insufficient.
- Whole-view proof budget64observation reads; omitted candidates remain unknown. Per-move exact read remains at most32lookups.

## Acceptance and test plan

- Unit: threshold/soak-ready without an outcome baseline, mismatched/foreign/future/stale/ambiguous/insufficient proof and throwing/missing reader all refuse with zero config writes and zero move-intent rows.
- Unit: valid exact baseline/current proof permits only the existing model-decided standard development-agent config move; it does not bypass sensitivity, coherence, soak or expected-old-config floors. Different parent/component/target proof fails.
- Unit: changing the live contract/config after a cached view cannot authorize a stale decision. Separate startable tests prove the final reviewed policy and its absence of side-effect activation loopholes.
- Integration: actual authenticated POST /maturation/moves carries the new explicit refusal and plain explanation. GET ladder distinguishes numeric readiness from move eligibility; peer origin stays selected.
- E2E: production AgentServer, actual D7 raw observations and exact registry-owned method flow through both a missing-evidence refusal and a legitimate managed move with readback; ordinary representative services remain reachable during a hold. Controlled fixtures are labelled test evidence, never deployed activity.
- Deployment: run required verification before release; replay real feature evidence through deployed read and inspect the phone view. Preserve explicit missing baselines rather than inventing a clean fleet.

## Rollback and limits

Revert restores the prior managed-move floor without data migration or changing running features. No automatic disabling, restarting, retiring or reverting ordinary services. Previously approved moves remain running. The new refusal is intentionally stricter and can hold every feature whose old contract lacks baseline metadata; report that count honestly and use existing corrective work to author meaningful contracts. Direct raw configuration writes and source-code promotion remain governed by their existing review authorities and are not certified as covered by this endpoint floor. Whole-effort readiness and component proof do not inherit a feature's outcome.

## Maturation plan

- **test-agent-live:** controlled production-AgentServer tests exercise exact raw proof, missing proof, owner collision, archive failure and zero-write refusals before release.
- **dev-agent-live:** after this Tier2 design is explicitly approved and required verification passes, exercise the existing development-agent ladder endpoint and inspect its truthful holds; do not activate a feature solely for the drill.
- **fleet:** retain the existing maturation.ladder deployment gate and development-agent write restriction. No separate default-on feature, new flag or fleet activation is introduced; where that existing endpoint is enabled, its approved evidence precondition applies.
- **graduation criterion:** existing maturation.ladder owns graduation; this increment additionally requires the full acceptance matrix, zero unsupported managed moves, ordinary-service availability during holds and verified human-readable eligibility before its delivery claim.
- **dark-window:** 0 days of a separate dark feature; this is an approved precondition on an existing gated endpoint, not a new background capability. Its release still waits for required verification and review.
- **ladder:** maturation.ladder

## Open questions

*(none)*

## Original-run carrier

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

This spec prepares the remaining enforcement increment within that existing run. It does not certify completion or extend the deadline. <!-- tracked: CMT-001 -->
