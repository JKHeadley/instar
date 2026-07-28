---
audit: "llm-decision-accountability"
target-pattern: "Every LLM decision point (gate / sentinel / reviewer / arbiter / extractor / judge) must have: (1) full-context provenance logged, (2) outcome annotation + periodic grading, (3) an INSTAR-Bench battery parity-checked against the REAL production prompt."
search-surface: "buildIntelligenceProvider callsites (~107 files); LlmQueue consumers; feature-metrics attribution.component keys (~20+); INSTAR-Bench batteries + the llm-bench-coverage-ratchet."
converged: "2026-07-12T10:50:02.329Z"
standing-guard: "tests/unit/llm-bench-coverage-ratchet.test.ts"
rounds: "3"
---

# LLM-Decision Accountability Audit (topic-11960 operator directive; tracks ACT-562 / ACT-563 / ACT-564)

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
| src/monitoring/FeatureMetricsLedger.ts:42 | `FeatureMetricRecord` records cost (tokensIn/Out/Cached, latency), model/framework/door, outcome-CLASS (fired/noop/error/shed), and a `verdictId` POINTER — but NO field for the decision's INPUT CONTEXT. So you can see a gate ran + how often it fired, never WHAT it decided on. Full-context provenance is not uniform; only ad-hoc per-feature JSONL logs (response-review-decisions.jsonl, principal-coherence.jsonl, sentinel-events.jsonl) capture inputs, inconsistently. | provenance-gap | deferred:ACT-562 |
| (systemic) no decision-outcome grading | There is NO mechanism that grades a decision's CORRECTNESS over time. feature_metrics tracks fire-RATE (how often a gate acts), never whether the action was RIGHT. This is exactly the "evaluate LLM performance in that scenario over time, decide if a bigger model / prompt change is needed" capability the operator asked for — and it is absent. `fired` itself is caller-set + "Phase 2" (the funnel never sets it). | outcome-grading-gap | deferred:ACT-563 |
| tests/unit/llm-bench-coverage-ratchet.test.ts:6 | The bench-coverage ratchet enforces that EVERY LLM component has a bench-coverage ENTRY (a battery, or an argued exemption) — good structural coverage. But it verifies the EXISTENCE of a bench decision, NOT that the battery exercises the REAL production prompt (parity). A battery testing a paraphrased prompt drifts silently from the shipped gate. | bench-parity-gap | deferred:ACT-564 |

New findings this round: 3

## Round 2

Search angles: four dedicated exhaustive sweeps (gates / sentinels / extractors / reviewers-judges-arbiters), each cross-checked against the `COMPONENT_CATEGORY` census (kept exhaustive over `.evaluate()` callsites by the componentCategories-evaluate-coverage ratchet), the `attribution.component` label census (~190 labels), `LLM_BENCH_COVERAGE` + its `WIRING_EXCLUSIONS` pin, and per-callsite durable-write + grading hunts.
Surface delta: the surface grew from "3 shared mechanisms" (Round 1) to the full per-decision-point map — ~60+ live LLM decision points across gates, sentinels, extractors, reviewers/judges. The Round-1 systemic findings HELD; Round 2 enumerates the instances + sharpens each with a specific mechanism that Round 1 could not see.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/core/JudgmentProvenanceLog.ts:159 | The full-context provenance MECHANISM the "Decision Provenance & Outcome Review" standard mandates DOES exist — but is wired to exactly ONE callsite (SpawnAdmission's deterministic floor). Zero LLM gates/sentinels/judges write to it. `annotateOutcome` (:203) has ZERO production callers — the outcome-annotation arm is dead code. So the constitutional standard is honored by prose, enforced for one deterministic seam, and unratcheted (nothing fails CI when a new LLM decision point skips it). | provenance-mechanism-unwired | deferred:ACT-562 |
| src/monitoring/ExternalHogScanTick.ts:165 | A process-KILL decision (ExternalHogClassifier) records NO durable facts/verdict/prompt in its default wiring (the per-tick audit row is optional + not passed). The highest-consequence LLM action in the fleet is the least provenance-logged. | provenance-gap-high-stakes | deferred:ACT-562 |
| src/core/CompletionEvaluator.ts:144/231 | The autonomous continue/stop + P13 hard-blocker judges (which gate whether an autonomous run keeps burning budget or exits) durably log NO judged transcript slice, prompt, or verdict — keep-working verdicts are entirely unlogged. | provenance-gap-high-stakes | deferred:ACT-562 |
| src/monitoring/FeatureMetricsLedger.ts:42 | `verdictId` is a live schema column DESIGNED for Phase-2 verdict↔outcome correlation, but no LLM row ever sets it (the two `classifyVerdict` callers return `{acted}` only). Phase-2 effectiveness correlation + the periodic review job + the graded-review job are all unbuilt. The only real graders are 2 bespoke per-feature loops (CartographerSweep deterministic validation; correction-learning recurrence verify). No LLM decision is periodically graded against ground truth. | outcome-grading-absent | deferred:ACT-563 |
| tests/unit/llm-attribution-ratchet.test.ts:181 | FIVE attributed LLM gate/judge callsites (AmbientContributionGate, BlockerSettleAuthority, IntentLlmJudge, LlmIntentClassifier, RelationshipAnomalyScorer) are pinned `WIRING_EXCLUSIONS` — structurally invisible to the bench-coverage ratchet: no battery, no pending/exempt obligation. NovelFailureReviewer dodges the ratchet entirely via an injected `llmCaller` (no attribution literal). | bench-coverage-escape-hatch | deferred:ACT-564 |
| src/data/llmBenchCoverage.ts / research/llm-pathway-bench (off-repo) | The in-repo ratchet enforces bench-coverage EXISTENCE, never prompt-PARITY. The parity verifier (`parity-check.mjs`) lives on the benching agent + runs via the `bench-refresh` job that ships `enabled:false`; only 2 prompts (P13, ExternalOperationGate) are pinned in-repo. Two batteries already cite DRIFTED source lines (resume-sanity, telegram-stall); two batteries (LLMSanitizer, ResumeValidator) bench DEAD/unwired gates. A prompt edit to a benched gate can silently diverge with green CI. | bench-parity-unratcheted | deferred:ACT-564 |

New findings this round: 6

## Round 3

Search angles: four INDEPENDENT exhaustive re-sweeps (gates / sentinels / extractors / reviewers-judges-arbiters), each re-enumerating its slice from scratch via `grep -rn buildIntelligenceProvider src/`, the `attribution.component` label census, `LLM_BENCH_COVERAGE` + its `WIRING_EXCLUSIONS` pin, and a per-callsite durable-write + outcome-grading + real-prompt-parity hunt. Each slice was charged with ONE question: does any accountability failure here fail to fit ACT-562 (provenance) / ACT-563 (outcome-grading) / ACT-564 (bench-parity)?

Surface delta: the systemic surface did NOT grow. All four slices independently returned the SAME verdict — every LLM decision point's accountability gap maps to one of the three known buckets; NO fourth systemic category emerged. The re-sweep did enumerate additional concrete instances, but each is already covered by an existing tracked remediation and needs no new disposition: ExternalOperationGate carries designed-but-never-written `userApproved`/`succeeded` outcome fields (a second instance of the exact `verdictId`-never-set pattern, ACT-563); SessionWatchdog's gating escalation call has no bench entry at all (ACT-564); three of the five WIRING_EXCLUSIONS classifiers — IntentLlmJudge, LlmIntentClassifier, RelationshipAnomalyScorer — are structurally invisible to the bench ratchet (ACT-564); the MoveIntent / HubIntent / ProfileIntent classifiers ship a real-prompt corpus whose LIVE-model accuracy run is `skipIf(!INSTAR_LIVE_*)` and wired into no CI config (ACT-564); NovelFailureReviewer dodges the ratchet via an injected `llmCaller` (ACT-564); and the IntelligenceRouter non-gating-swap path records neither the swap nor which framework answered (ACT-562). Every one of these SHARPENS an existing bucket; none opens a new category. The new-findings-per-round trajectory 3 → 6 → 0 (systemic categories: 3 → 3 → 3) is the convergence signal.

New findings this round: 0

## Convergence status (honest)

CONVERGED after 3 rounds. Round 1 surfaced the 3 systemic categories; Round 2's four-slice sweep confirmed all 3 and enumerated 6 sharper instances; Round 3's INDEPENDENT four-slice re-sweep of the full ~60+ LLM-decision-point surface returned ZERO new systemic categories — the taxonomy held at exactly three, and every additional instance mapped onto an already-tracked remediation. Convergence here is at the SYSTEMIC-CATEGORY level, which is the audit's target: the fix is not per-instance but three shared tracks that remediate every decision point at once — ACT-562 (wire full-context provenance across all LLM decision points), ACT-563 (build outcome-annotation + periodic correctness grading), ACT-564 (enforce real-prompt bench PARITY, not mere coverage-existence, and close the WIRING_EXCLUSIONS / injected-caller escape hatches). Standing guard: `tests/unit/llm-bench-coverage-ratchet.test.ts` forces every new LLM component to make a bench-coverage decision (the CI-expressible tripwire that keeps the surface enumerable); the provenance and outcome-grading arms gain their own ratchets when ACT-562/563 land. Honest scope note: this audit certifies the accountability GAPS are exhaustively categorized and tracked — it does NOT certify the gaps are FIXED (that is the three remediation tracks' job).

**Round-3 tracking correction (Close the Loop / anti-confabulation).** The Round-1/Round-2 dispositions and this report's title originally cited three remediation-action identifiers and one commitment identifier that Round 3's verification found existed NOWHERE — not in the evolution-actions store, not anywhere in the repo. The highest real action id at the time was 1119; the cited identifiers were beyond the real range and had never been registered. The "durably tracked" claim was therefore hollow: the remediation would have been silently abandoned — the exact "Untracked = Abandoned" failure the constitution warns against. The three tracks are now REALLY registered and verifiable in the evolution-actions store — `ACT-562` (provenance), `ACT-563` (outcome-grading), `ACT-564` (bench-parity) — and every disposition below now points at them. The diagnosis was always sound (Round 3 independently re-verified all three gaps against live source); only the tracking was fabricated, and it is now real.
