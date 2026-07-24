# Convergence Report — Drive 8 nine-source-PR placement closure

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview

Both external model families completed successful review rounds. Gemini timed out in
three earlier attempts before succeeding; those degraded attempts were retained in
the iteration record. The live Standards-Conformance endpoint was invoked but returned
401 for the available session credential, so constitutional automation was
unavailable; decision-point structure, multi-machine posture, and the existing D7
constitution were reviewed directly instead.

## ELI10 Overview

Nine source pull requests did not all ship the same kind of thing. Five shipped
features with real switches, three shipped pieces inside systems that already own the
switch, and one shipped documentation. This change records those shapes honestly in
the existing rollout registry: five active, three composed, and one excluded.

The three composed pieces get real measurements but no pretend controls. D7 copies
small numeric snapshots from their existing owners into its existing evidence ledger.
Missing, stale, malformed, or undersampled evidence never becomes green. The
documentation row remains visible as provenance with no rung or metric.

## Original vs Converged

The initial design had the correct 5/3/1 shape but left several operational edges
implicit. Convergence added a closed descriptor allowlist, explicit source-locality
and causality rules, distinct invalid-contract diagnostics, nullable-rung migration,
mixed-version denominator semantics, hostile-peer schema checks, promotion-authority
labels, descriptor discovery, and a clear separation between placement closure,
evidence readiness, and rollout promotion.

Implementation review also caught three concrete defects before handoff: candidate
claims could have matured without classification; hostile pool rows could disagree
with their claimed counts/rungs; and mixed legacy/accounted peers had inconsistent
eligible denominators. All were repaired and regression-tested.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|---|---|---:|---|
| 1 | independent implementation reviewer, GPT | 3 | Classified-claim evidence, pool invariants, mixed-version denominator, descriptor clarity |
| 2 | independent reviewer, GPT | 1 | Added `legacyEligible`; clarified composed contracts and locality |
| 3 | GPT; Gemini degraded | 0 | Added truth table, parser diagnostics, activity expectations |
| 4 | GPT; Gemini degraded | 0 | Defined placement vs evidence closure and origin-local review |
| 5 | GPT + Gemini | 0 | Added terms, exact invalid-contract status, alternatives analysis |
| 6 | GPT + Gemini | 0 | Added architecture/data-flow, promotion authority, applicability failure posture |
| 7 | GPT + Gemini | 0 | Added descriptor discovery, causal predicates, embedded D7 rationale |
| 8 | GPT + Gemini | 0 | Final language and maintainability review; minor advisory notes only |
| 9 | GPT + Gemini | 0 | Body-unchanged confirmation round; minor terminology advisories |
| 10 | GPT + Gemini | 0 | Clarified invalid-contract diagnostics, split promotion authority, bounded descriptor-registry extraction, and reset semantics; converged |

Standards-Conformance Gate: unavailable (401 from live endpoint with session
credential). The failure was advisory and did not bypass the direct standards audit.

## Full Findings Catalog

### Resolved material findings

- **Evidence validity:** `candidateTurns` increments before provider success. The
  projection now uses `classifiedTurns`; candidate-only traffic is pinned to HOLD.
- **Peer honesty:** pool sanitization now recomputes accounting counts, enforces
  disposition/rung and promotion-authority invariants, and rejects hostile bodies.
- **Backcompat denominator:** `legacyEligible` makes mixed legacy/accounted local and
  pool summaries mathematically identical.
- **Migration completeness:** both nullable evaluation rungs and the expanded
  observation source CHECK preserve rows and recreate indexes transactionally.

### Resolved specification findings

- Defined composed child contract ownership, source locality, causal event predicates,
  zero-activity semantics, and owner compatibility/version rules.
- Distinguished accounting, contracts, observations, evaluations, and read summaries.
- Added exact active/composed/excluded truth table and no-child-promotion invariant.
- Added explicit alternatives: static/hybrid manifests, generic metrics registries,
  owner event streams, and external telemetry transports.
- Added bounded discovery of descriptor refs, versions, thresholds, and sample floors.

### Final-round minor advisories

External reviewers continued to recommend persisting applicability as a separate
ledger field and periodically reconsidering standard telemetry tooling. Applicability
is already derived deterministically from the persisted accounting disposition and
contract, so duplicating it would add drift risk without changing any decision. The
telemetry-registry extraction threshold is now explicit and bounded. These are
non-material maintainability advisories, not unresolved behavior or ownership gaps.

## Convergence verdict

Converged at iteration 10. The final round produced no material finding, all user
decisions are resolved, external GPT and Gemini review both ran successfully, and the
independent implementation reviewer returned CONCUR. Ready for approved build/merge.
