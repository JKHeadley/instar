# Convergence Report — Claim Verification

## Cross-model review: codex-cli:gpt-5.5

External review ran successfully on the converged body through Codex (`gpt-5.5`) and Gemini (`gemini-3.1-pro-preview`). The Anthropic clean-door reviewer was unavailable with `no-supported-framework`; it is disclosed separately and does not count as cross-family review.

The code-backed Standards-Conformance Gate was invoked in every reviewed round. The live server returned `503 constitution unreadable` because its main checkout lacked `docs/STANDARDS-REGISTRY.md`. Per the skill contract this was recorded as a degraded, fail-open constitutional pass—not a clean result and not a reason to stall convergence.

## ELI10 Overview

This design adds a dark observer for factual claims in Claude Code responses. It notices claims, assigns a minimum harm level, and checks a small finite set against fresh structured sources. It never stops, rewrites, delays, corrects, or authorizes a message in v1. Capacity and pull-request claims are deliberately called unverifiable because Instar does not currently have canonical sources for them.

The useful v1 output is measurement: a scrubbed local corpus of claim shapes, deterministic outcomes, model route, cost, and latency. It contains no raw response or raw evidence and cannot train, route, calibrate, or promote anything. All metrics are labeled “server-admitted only”; v1 cannot claim production coverage or recall. V2 miner/due-diligence and v3 calibration are illustrative constraints only and require separately converged trusted substrates.

## Original vs Converged

The initial design risked creating a second claim engine, using prose as a capacity oracle, trusting pooled audit rows, and overbuilding a custom signed transparency log. The converged design extends the one existing `ClaimClauseArbiter`/`CompletionClaimVerifier` path, leaves capacity and PR facts unverifiable, keeps v1 rows local and automation-ineligible, and makes a future Verified Claim Evidence Ledger a separate technology decision rather than inventing it here.

Review also made the boundary honest and implementable: one same-origin Claude subscription door, fail-closed privacy policy, fixed request/model/queue/storage/pool bounds, deterministic extraction-gap signals, admitted-path-only metrics, a concrete SecretStore key lifecycle, origin-side privacy thresholds, restart-required rollback semantics, hermetic delivery tests, and no v2/v3 stubs in the v1 build.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | security, scalability, adversarial, integration, decisions, external | 14 | Reused the live claim pipeline; removed the duplicate extractor/authority; rejected prose capacity truth; added initial bounds and v2 prerequisites. |
| 2 | security, integration, decisions, external | 11 | Typed operands/selectors/comparators, authenticated scope, deterministic tense/freshness, observe-only disposition, migration and rollback contracts. |
| 3 | scalability, adversarial, integration | 8 | Queue/fairness/spend caps, consequence uncertainty floors, fenced v2 ownership, correction idempotency and evidence validation. |
| 4 | security, integration, decisions | 7 | Corpus trust classes, privacy retention, generated-hook parity, Decision Quality/pool projection limits, no raw-message escrow. |
| 5 | security, scalability, external | 6 | Removed custom distributed transparency machinery; made local corpus automation-ineligible; added the separately converged evidence-ledger prerequisite. |
| 6 | adversarial, integration, decisions | 5 | Defined ordinary JSON wire, candidate/cue behavior, correction aggregation, server-admitted denominator, and conditional v2/v3 posture. |
| 7 | security, scalability, adversarial, integration, decisions, foundation, external | 16 | Added provider scrub/policy boundary, exact ingress/queue/storage/pool limits, late-refutation reopening, restart semantics, storage/key lifecycle, frontloaded decisions, and signal-authority correction. |
| 8 | integration, external | 8 | Removed invented PR oracle, made v1 rows miner-ineligible, added prospective ledger cohorts, topic privacy thresholds, admitted-path error budgets, DLP residual tests, no-ledger-stub criterion, and clearer non-goals. |
| Final same-body round | all six internal reviewers | 0 | None. Exact body reviewed clean internally. External remaining comments were repeats, readability preferences, future-spec suggestions, or caused by truncated context; none required a design change. |

## Full Findings Catalog

### Pipeline, evidence, and authority

- **Duplicate verifier/extractor and outbound authority risk (serious; integration/foundation):** resolved by extending only `ClaimClauseArbiter` and `CompletionClaimVerifier`; general v1 results cannot enter `routeActionClaim` or sender disposition.
- **Model consensus/prose treated as truth (serious; security/adversarial):** resolved by a closed deterministic verifier catalog; unsupported, stale, ambiguous, partial, capacity, PR, and external facts are `unverifiable`.
- **Criticality could be weakened by hedging, ambiguity, or future calibration (serious; adversarial):** resolved with deterministic minimum floors, irreversible consequence round-up, and conservative-only calibration.
- **Benchmark-divergence detector became routing authority (material; lessons/foundation):** resolved by naming `ClaimRecipeInvariantGate` as sole future activation/demotion authority; divergence is advisory input only.

### Extraction and recall

- **Single LLM extraction miss/evasion (serious; adversarial/external):** resolved with deterministic protected/injection gap signals, synthetic silent-miss experiments, cue-free/adversarial/quotation strata, explicit semantic-field error budgets, and an honest statement that production recall is unknown.
- **Four-claim ceiling biases dense messages (material; scalability/external):** resolved with deterministic priority, saturation marking, separate prevalence/density metrics, and exclusion from recall, frequency, miner, and graduation conclusions.
- **Candidate split and wire ambiguity (material; decisions/external):** resolved with advisory-only candidate boundaries, full-message model input, exact ordinary JSON schema, maximum-cardinality proof, and scrubbed-byte offset semantics.

### Security and privacy

- **Provider-boundary data leakage (high; security):** resolved with `ClaimObservationScrubber`, fixed typed placeholders, deterministic fail-closed `ClaimContentPolicy`, same-origin Claude subscription door only, no fallback, bounded inputs, and provider-mock/fuzz/secret-corpus tests.
- **Pseudonym/linkability and key loss (material; security/integration):** resolved with a concrete encrypted SecretStore key, atomic get-or-create, domain-separated IDs, key-loss quarantine, retention, and conservative origin-side cohort suppression.
- **Pool re-identification and false topic diversity (material; integration):** resolved by qualifying cohorts independently at each origin with 20 rows/5 local topics and merging only already-qualified aggregates.
- **Custom transparency-log overbuild (serious; security/external):** removed from v1. Local rows are observational; trusted automation waits for a separately converged ledger and threat model.

### Bounds and operability

- **Unbounded request/evidence/model/queue/storage/pool work (serious; scalability):** resolved with exact byte/cardinality/token/cost/concurrency/TTL/peer/page/deadline caps and deterministic drop/expiry behavior.
- **Corpus cap had no legal victim (material; scalability):** resolved by expired-first removal then rejecting the new row with `corpus_capacity_drop` rather than deleting retained rows.
- **Restart-required config contradicted immediate rollback (material; integration):** resolved by explicitly requiring controlled restart, immutable boot IDs, in-memory queue abandonment, and no claimed live config epoch.
- **Legacy deletion and corpus storage were unwired (material; integration):** resolved with canonical paths, backup/file-view exclusion, bounded boot/6-hour housekeeper, and retention receipts.

### Future v2/v3 boundaries

- **Invented PR/capacity oracles (material; integration):** both remain `unverifiable:no-canonical-oracle` in v1.
- **V1 rows could not prove future topic/principal diversity (material; integration):** resolved by making them permanently miner-ineligible; miner cohorts begin prospectively under ledger-native installation-wide identities.
- **Premature miner/workflow/ledger coupling (serious; decisions/external):** §§3-4 are explicitly illustrative, require separate convergence, and v1 acceptance forbids ledger APIs, IDs, schemas, registries, correction outboxes, and v2/v3 stubs.
- **Late canonical refutation could never correct (material; adversarial):** future correction design now permits one bounded late reopen when no correction was previously reserved or delivered.

### Decision completeness

- Final counts: **9 frontloaded decisions**, **0 cheap-to-change tags**, **0 contested-then-cleared**, **0 open user decisions**.
- Same-origin provider policy, T0-only v1 labels, hermetic delivery tests, unsupported PR/capacity predicates, SecretStore lifecycle, restart rollback, corpus posture, and v2/v3 stop line are all decided in the document.

## External final-round disposition

Codex and Gemini both completed on the final reviewable body. Their final `MINOR ISSUES` were non-material: requests to repeat an existing required-vs-future table, add a non-LLM comparator already supplied by the deterministic gap lane and stratified synthetic tests, move already isolated illustrative sections to an appendix, expand an existing glossary/foundation table, or provide context that the review wrapper reported as truncated. No final comment identified an unresolved authority, security, scaling, integration, or builder-decision defect.

## Convergence verdict

Converged at iteration 8 plus a final same-body confirmation round. All six mandatory internal perspectives returned `CLEAN` on the exact final body. There are no unresolved user decisions. The spec is ready for operator review; it does not authorize runtime implementation, deployment, or a build PR.
