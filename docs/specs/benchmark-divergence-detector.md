---
title: "Benchmark-Divergence Detector — real grades vs benchmark predictions (the feedback loop, Increment A)"
slug: "benchmark-divergence-detector"
author: "echo"
parent-principle: "Decision Provenance & Outcome Review"
---

# Benchmark-Divergence Detector — real grades vs benchmark predictions

**Origin:** operator, topic 11960, 2026-07-12: *"our current benchmark assumes some models perform very well in certain scenarios; if the real-life data suggests otherwise then we need to re-evaluate all aspects of that scenario, including whether the model is getting enough context, whether the model has an appropriate prompt, and whether the benchmark is appropriately representing the scenario."* Operator approved building the loop ("yes, please proceed") and gave two first-class requirements (R1, R2 below).

**This spec = Increment A** of the benchmark-feedback loop: the divergence DETECTOR. It is observe-only and in-repo. Increment B (bench prompt-parity faithfulness, ACT-1195) and Increment C (representative-cases feed) are **explicitly non-scope** here (see Non-scope) — B is the recommended precondition but has an off-repo dependency and is specced separately; scope confirmation (A-only vs A+B) is an operator decision surfaced in-topic. <!-- tracked: ACT-1195 -->

**Depends on:** the LLM-Decision Quality Meter (`docs/specs/llm-decision-quality-meter.md`, merged; PR #1458) for the real production grades. This detector reads those grades; it is inert (no data) until the meter's `provenance.uniformSeam` is flipped live and grades accumulate. That gates live *function*, not the *build* (ships dark).

## Problem statement

The **benchmark** (INSTAR-Bench v2) is a PREDICTION: per component/decision-point, it asserts an effectiveness rate ("this model is good at scenario S"). The **quality meter** is GROUND TRUTH: per decision-point, the real production grade-rate (right/wrong/unknown). Today nothing compares the two, so when reality contradicts the prediction — the signal the operator wants to act on — it is invisible; and worse, the raw grade data is deleted on a retention clock (14d provenance / 30d metrics / 90d quality) before anything analyzes it. This feature closes both gaps: it compares real grade-rate to predicted rate per component, and it guarantees the comparison consumes the data before retention deletes it.

## Data flow — THREE distinct stages (the conceptual backbone)

The operator asked whether grading is ongoing vs. collect-then-analyze, and whether grading is separate from analysis. It is three separate stages with three separate consumers of the data:

1. **RECORD (continuous, per-decision):** the correlation spine + provenance (BUILT by the meter). Every enrolled high-stakes decision records what it saw (context) + chose, live as decisions occur. No benchmark involvement.
2. **GRADE (periodic, evidence-triggered):** the meter's grade-pass job (BUILT). As reality's evidence matures (did the killed process come back? did the "done" run finish?), it stamps each recorded decision right/wrong/unknown — per-DECISION, against reality. It has its OWN cursor (`decision_grading_cursor`). Does NOT touch the benchmark.
3. **ANALYZE (periodic, less frequent — THIS feature):** the divergence detector reads the accumulated GRADES (pool-wide, R2), aggregates the real grade-rate per component, compares to the benchmark's PREDICTED rate, and on divergence emits a finding carrying the 3 ranked questions. It has its OWN watermark (R1 `analyzed`), DISTINCT from the grading cursor — grading and analysis are separate consumers.

The improvement loop: grades = ground truth → analysis forks a divergence into **fix-the-SYSTEM** (context/prompt) vs **fix-the-BENCHMARK** (drift/unrepresentative). The fork = the 3 questions. The detector points at what to fix; humans and the later increments do the fixing. This is *Decision Provenance & Outcome Review* extended one layer: the outcome grades, once reviewed against the benchmark's promise, compound into a better benchmark and better model routing (*Never-Waste Feedback*).

## Frontloaded decisions

- **FD1 — Prediction source (in-repo mirror), GROUNDED against the live batteries.** The "prediction" is NOT a stored field — it is the battery-run **pass-rate**: INSTAR-Bench's `aggregate.mjs` computes `passRate = passes / deterministic` (3-dp) per `(taskId, model)` over the battery's cases (each case carries an `expected` answer; scored via the task's `scoring` method). It is **per-model** (a task is A/B-run across many models via `ab-run.mjs`). The battery + its raw results live off the main instar repo (`research/llm-pathway-bench/instar-bench-v2/…`). The detector runs IN-REPO against a small, content-free mirror: `{ taskId → { perModel: { <model> → passRate }, benchedPromptSource, promptFidelity, benchedPromptHash, capturedAt } }`, where `benchedPromptSource` is the task's `source` (e.g. `src/core/CompletionEvaluator.ts:137`), `promptFidelity` is the task's fidelity descriptor (e.g. `"verbatim (…parameterized…)"`), and `benchedPromptHash` is the hash of the resolved `promptTemplate`. Heavy battery runs stay off-repo; only this projection is mirrored in-repo (like the 2 already-pinned prompts). The mirror's staleness (`capturedAt`) is surfaced on every read, never hidden. Mirror population is an operational pull step; the in-repo format + the detector build independently of it.
- **FD2 — Comparison unit (per decision-point × MODEL).** Because the prediction is per-model (FD1), the comparison must be too: for each decision-point that has BOTH a `LLM_BENCH_COVERAGE {task}` entry AND quality-meter grade rows, compare the production **real grade-rate for the model that decision-point actually ran on** against **that same model's** benched `passRate` for the mapped task. Divergence = `|realGradeRate − predictedRate(model)| > divergenceThreshold` with `n ≥ minSample` (reuse the meter's `minSampleForRates`). Below sample → `insufficient-evidence`, never a flag. A production model absent from the battery's `perModel` set → `no-benched-baseline` (surfaced, never a silent skip — it is itself a signal the battery should add that model). Keys on the stable decision-point id, not just the component (a component may hold several decision points — LES from the meter's convergence).
- **FD3 — Output (observe-only).** A durable divergence-finding record + a `GET /benchmark-divergence` read surface. Each flagged component carries the 3 RANKED questions (0-precondition benchmark-faithful / 1-context / 2-prompt / 3-fidelity). It NEVER auto-acts, alerts, or gates — a pure signal (per *Signal vs. Authority*). Any future "your benchmark is diverging" alert is a separate future extension that would then owe Standard-B (notification) design; it is not in this build.
- **FD4 (R1) — Analyzed watermark + retention safety.** A per-component (per-machine) `analyzed` watermark, DISTINCT from the grading cursor, marking exactly which grade rows the detector consumed — so every row is analyzed exactly once (no skip, no double-count). The raw `decision_quality`/outcome rows PRUNE ONLY AFTER `analyzed ≥ row` AND their essence is rolled into a durable content-free summary (extend `decision_quality_rollup` + a new `benchmark_divergence_findings` table). "Raw data ages out on schedule; what we LEARNED never does." The retention prune-gate reads the watermark — verified by a wiring test that the gate is not a no-op.
- **FD5 (R2) — Cross-machine collection at analysis time.** Quality data is machine-local (the meter's ratified posture). The analysis gathers EVERY machine's grades into one pool view AT THE MOMENT IT RUNS (extends the meter's `?scope=pool` read-merge). An offline machine → that component's result is `partial`, re-collected when it returns; the detector NEVER concludes from an incomplete pool. The R1 watermark is therefore PER-MACHINE so a re-collect resumes correctly. A single-machine install is a pool-of-one (no partial states).
- **FD6 — Ship dark / dryRun-first, dev-gated.** Routes 503 when the flag is off. Ships dark on the fleet and (per the dev-agent gate posture) live-in-dryRun on a development agent — observe-only from day one; a durable finding is only WRITTEN once the flag is deliberately enabled. Config: `benchmarkDivergence.*`.

## Config surface + durable schema

- **Config (`benchmarkDivergence.*`, all existence-checked in `migrateConfig`):** `enabled` (dev-agent gate when omitted), `dryRun` (default true — writes no durable finding), `divergenceThreshold` (default 0.15 absolute), `minSampleForRates` (falls through to `provenance.quality.minSampleForRates`, default 20), `mirrorPath` (in-repo path of the FD1 projection), `analysisCadenceHours` (the ANALYZE-stage cadence; the driving job's schedule), `mirrorStalenessWarnDays` (surface the mirror as stale past this).
- **Durable schema (additive, alongside the meter's tables):**
  - Extend `decision_quality_rollup` (the meter's 90d content-free daily aggregate) so a raw-row prune is safe once its grade-rate essence is rolled up — the retention prune-gate reads the R1 watermark AND requires the rollup row present.
  - New `benchmark_divergence_findings` (content-free): `(taskId, decisionPointId, model, realGradeRate, predictedRate, delta, n, verdict ∈ {divergent, aligned, insufficient-evidence, no-benched-baseline, partial}, benchedPromptHash, mirrorCapturedAt, analyzedThroughMachine, firstSeenAt, lastSeenAt)`. A finding is an upsert keyed on `(taskId, decisionPointId, model)` — re-analysis updates one row, never appends duplicates.
  - New `benchmark_analysis_watermark` (R1, per-machine): `(machineId, componentKey, analyzedThroughRowId, updatedAt)` — the stage-3 watermark, distinct from the meter's `decision_grading_cursor`.

## The 3 ranked questions (surfaced per flagged component)

0. **Benchmark faithful? (precondition.)** Is the benched prompt == the live prompt? (`benchedPromptHash` vs the live prompt hash.) If drifted, the divergence is a benchmark bug → route to Increment B (prompt-parity), NOT a model verdict. This is the load-bearing ordering insight: you can only trust "the benchmark says X" if the benchmark is faithful to production.
1. **Enough context?** The meter records what each WRONG decision saw — inspect for context-starvation.
2. **Right prompt?** The live prompt vs the benched prompt (the prompt-parity check).
3. **Benchmark represents reality?** Are the battery's cases drawn from real production cases the meter captured, or hand-picked? (→ Increment C.)

## Non-scope (explicit, tracked)

- **Increment B — bench prompt-parity ratchet** (the faithfulness precondition): move/mirror the off-repo `parity-check.mjs` into an in-repo ratchet so a prompt edit to a benched gate fails CI unless the battery is refreshed; close the `WIRING_EXCLUSIONS` escape hatch (5 judges) + the injected-llmCaller dodge. Separate spec; tracked ACT-1195. <!-- tracked: ACT-1195 -->
- **Increment C — representative-cases feed**: the meter's real production cases (context-redacted) seed/validate the battery's scenarios. Separate future increment. <!-- tracked: ACT-1195 -->
- **Any operator alerting / watcher** on divergence — this build is a pull surface only (no attention items, no notices), so no Self-Heal-Before-Notify surface is introduced. A future alerting extension would owe that design.

## Testing (all three tiers, per Testing Integrity)

- **Unit:** divergence math (both sides of the threshold + `insufficient-evidence` exactly at the sample boundary); analyzed-watermark advances exactly-once (no skip / no double); prune-gate REFUSES to prune an unanalyzed row; rollup preserves the grade-rate essence after a raw prune; per-machine watermark resume. Injected clocks throughout.
- **Integration:** `GET /benchmark-divergence` 200-with-data / 503-dark / Bearer-required / `?scope=pool` field-allowlist strips hostile peer fields.
- **Cross-machine:** pool-collect merges N machines' grades; an offline machine → `partial` + re-collect on return (never concludes); the watermark is per-machine.
- **E2E (feature-alive):** single-machine boot with the flag on → route returns 200-not-503 (the single most important test).
- **Wiring integrity:** the retention prune-gate actually reads the watermark (not a no-op); mirror-staleness is surfaced on the read.

## Migration parity + agent awareness

- CLAUDE.md template capability section + a proactive trigger ("real production data contradicts the benchmark → read `GET /benchmark-divergence`"); `migrateClaudeMd` twin with a content-sniff guard; `CapabilityIndex` entry; config defaults via `migrateConfig` (existence-checked).

## Dependencies / open

- Quality meter merged (PR #1458) + its seam eventually flipped live → real grades exist. Blocks live function, not the (dark) build.
- FD1 mirror population needs an off-repo pull from the benching agent (operational step; the in-repo format + the detector build independently).
- Increment B (prompt-parity) is the faithfulness precondition; scope A-only vs A+B is an operator decision surfaced in-topic. <!-- tracked: ACT-1195 -->
- ~~Open: does INSTAR-Bench export a per-scenario predicted rate?~~ **RESOLVED (grounded against the live batteries 2026-07-12):** yes — `aggregate.mjs` emits a per-`(task, model)` `passRate` (passes/deterministic); that IS the prediction, and it is per-model (see FD1/FD2). Remaining converge grounding: confirm the exact mirror-pull cadence + whether the production model↔framework mapping the meter records lines up 1:1 with the battery's model ids (a normalization table may be needed).

## Parent audit

`docs/audits/llm-decision-accountability.md` (ACT-1193 ✅ provenance / ACT-1194 ✅ outcome-grading / ACT-1195 = the faithfulness half, Increment B). This detector is the analysis layer that turns ACT-1194's grades into the operator's re-evaluation signal.
