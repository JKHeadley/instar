---
audit: "llm-decision-accountability"
target-pattern: "Every LLM decision point (gate / sentinel / reviewer / arbiter / extractor / judge) must have: (1) full-context provenance logged, (2) outcome annotation + periodic grading, (3) an INSTAR-Bench battery parity-checked against the REAL production prompt."
search-surface: "buildIntelligenceProvider callsites (~107 files); LlmQueue consumers; feature-metrics attribution.component keys (~20+); INSTAR-Bench batteries + the llm-bench-coverage-ratchet."
converged: ""
standing-guard: "tests/unit/llm-bench-coverage-ratchet.test.ts"
---

# LLM-Decision Accountability Audit (CMT-1962)

Run as an **iterative converging audit** (the process built in `audit-convergence-enforcement`,
per its §5 bootstrap clause — the first audit under the directive uses this canonical format +
the validator manually, before the gate PR merges). Classifies every LLM decision point against
the **Decision Provenance & Outcome Review** standard: provenance logged / outcomes graded /
bench battery parity-checked against the real production prompt.

<!-- Rounds appended below as the sweep + re-sweeps complete. -->

## Round 1

Search angles: `grep -rn buildIntelligenceProvider src/` (107 files); the `feature_metrics` schema (`src/monitoring/FeatureMetricsLedger.ts` `FeatureMetricRecord`); the bench ratchet (`tests/unit/llm-bench-coverage-ratchet.test.ts`) + `COMPONENT_CATEGORY`; a grep for any decision-outcome-correctness grading mechanism; per-feature ad-hoc decision logs (`*-decisions.jsonl`).
Surface delta: initial sweep — the surface is the ~107 buildIntelligenceProvider callsites + the 3 shared accountability mechanisms (feature-metrics ledger, bench ratchet, per-feature JSONL logs). Round 2 must enumerate each callsite against the 3 criteria (the per-callsite enumeration is the surface that grows).

**Systemic infrastructure findings (the crux — these dominate the per-feature detail):**

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/monitoring/FeatureMetricsLedger.ts:42 | `FeatureMetricRecord` records cost (tokensIn/Out/Cached, latency), model/framework/door, outcome-CLASS (fired/noop/error/shed), and a `verdictId` POINTER — but NO field for the decision's INPUT CONTEXT. So you can see a gate ran + how often it fired, never WHAT it decided on. Full-context provenance is not uniform; only ad-hoc per-feature JSONL logs (response-review-decisions.jsonl, principal-coherence.jsonl, sentinel-events.jsonl) capture inputs, inconsistently. | provenance-gap | deferred:ACT-1193 |
| (systemic) no decision-outcome grading | There is NO mechanism that grades a decision's CORRECTNESS over time. feature_metrics tracks fire-RATE (how often a gate acts), never whether the action was RIGHT. This is exactly the "evaluate LLM performance in that scenario over time, decide if a bigger model / prompt change is needed" capability the operator asked for — and it is absent. `fired` itself is caller-set + "Phase 2" (the funnel never sets it). | outcome-grading-gap | deferred:ACT-1194 |
| tests/unit/llm-bench-coverage-ratchet.test.ts:6 | The bench-coverage ratchet enforces that EVERY LLM component has a bench-coverage ENTRY (a battery, or an argued exemption) — good structural coverage. But it verifies the EXISTENCE of a bench decision, NOT that the battery exercises the REAL production prompt (parity). A battery testing a paraphrased prompt drifts silently from the shipped gate. | bench-parity-gap | deferred:ACT-1195 |

New findings this round: 3

## Round 2

Search angles: four dedicated exhaustive sweeps (gates / sentinels / extractors / reviewers-judges-arbiters), each cross-checked against the `COMPONENT_CATEGORY` census (kept exhaustive over `.evaluate()` callsites by the componentCategories-evaluate-coverage ratchet), the `attribution.component` label census (~190 labels), `LLM_BENCH_COVERAGE` + its `WIRING_EXCLUSIONS` pin, and per-callsite durable-write + grading hunts.
Surface delta: the surface grew from "3 shared mechanisms" (Round 1) to the full per-decision-point map — ~60+ live LLM decision points across gates, sentinels, extractors, reviewers/judges. The Round-1 systemic findings HELD; Round 2 enumerates the instances + sharpens each with a specific mechanism that Round 1 could not see.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/core/JudgmentProvenanceLog.ts:159 | The full-context provenance MECHANISM the "Decision Provenance & Outcome Review" standard mandates DOES exist — but is wired to exactly ONE callsite (SpawnAdmission's deterministic floor). Zero LLM gates/sentinels/judges write to it. `annotateOutcome` (:203) has ZERO production callers — the outcome-annotation arm is dead code. So the constitutional standard is honored by prose, enforced for one deterministic seam, and unratcheted (nothing fails CI when a new LLM decision point skips it). | provenance-mechanism-unwired | deferred:ACT-1193 |
| src/monitoring/ExternalHogScanTick.ts:165 | A process-KILL decision (ExternalHogClassifier) records NO durable facts/verdict/prompt in its default wiring (the per-tick audit row is optional + not passed). The highest-consequence LLM action in the fleet is the least provenance-logged. | provenance-gap-high-stakes | deferred:ACT-1193 |
| src/core/CompletionEvaluator.ts:144/231 | The autonomous continue/stop + P13 hard-blocker judges (which gate whether an autonomous run keeps burning budget or exits) durably log NO judged transcript slice, prompt, or verdict — keep-working verdicts are entirely unlogged. | provenance-gap-high-stakes | deferred:ACT-1193 |
| src/monitoring/FeatureMetricsLedger.ts:42 | `verdictId` is a live schema column DESIGNED for Phase-2 verdict↔outcome correlation, but no LLM row ever sets it (the two `classifyVerdict` callers return `{acted}` only). Phase-2 effectiveness correlation + the periodic review job + the graded-review job are all unbuilt. The only real graders are 2 bespoke per-feature loops (CartographerSweep deterministic validation; correction-learning recurrence verify). No LLM decision is periodically graded against ground truth. | outcome-grading-absent | deferred:ACT-1194 |
| tests/unit/llm-attribution-ratchet.test.ts:181 | FIVE attributed LLM gate/judge callsites (AmbientContributionGate, BlockerSettleAuthority, IntentLlmJudge, LlmIntentClassifier, RelationshipAnomalyScorer) are pinned `WIRING_EXCLUSIONS` — structurally invisible to the bench-coverage ratchet: no battery, no pending/exempt obligation. NovelFailureReviewer dodges the ratchet entirely via an injected `llmCaller` (no attribution literal). | bench-coverage-escape-hatch | deferred:ACT-1195 |
| src/data/llmBenchCoverage.ts / research/llm-pathway-bench (off-repo) | The in-repo ratchet enforces bench-coverage EXISTENCE, never prompt-PARITY. The parity verifier (`parity-check.mjs`) lives on the benching agent + runs via the `bench-refresh` job that ships `enabled:false`; only 2 prompts (P13, ExternalOperationGate) are pinned in-repo. Two batteries already cite DRIFTED source lines (resume-sanity, telegram-stall); two batteries (LLMSanitizer, ResumeValidator) bench DEAD/unwired gates. A prompt edit to a benched gate can silently diverge with green CI. | bench-parity-unratcheted | deferred:ACT-1195 |

New findings this round: 6

## Convergence status (honest)

NOT yet formally converged. Round 1 surfaced the 3 systemic categories; Round 2's exhaustive four-slice sweep confirmed all 3 and enumerated 6 specific, sharper instances (no NEW systemic category emerged — a good convergence signal). A formal converged stamp requires one more full re-sweep (Round 3) returning zero new — deliberately NOT stamped `converged:` here, honoring the very discipline this audit dogfoods: an honestly-incomplete audit is committable, but cannot wear the earned stamp. The actionable crux (the 3 remediation tracks) is already delivered + durably tracked (ACT-1193 provenance, ACT-1194 outcome-grading, ACT-1195 bench-parity).
