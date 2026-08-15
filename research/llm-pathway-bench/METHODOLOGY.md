# LLM Pathway Characterization — Round Methodology (execution plan)

Driver: `run-round.mjs` (consolidates per-round summaries). Harness: `harness.mjs`.
Intensity rule: keep benchmark concurrency below the host spawn cap (8) with headroom,
so benchmark load never starves the agent's own outbound path (tone gate on pi). Heavy
codex runs (45–61s/call) go in the background at concurrency 1.

## R2 — Baseline (uncontended)
- Cells: 8 pathways × {synthetic `ping`, real `real-msg-classify`}. N≥30/cell, concurrency 1.
- Fast pathways (claude×3, pi, gemini) first (low pressure); codex×3 in background after.
- Report per cell: okRate, p50/p95/p99 latency, meanIn/meanOut tokens, cost where surfaced.
- Confidence: N≥30 + repeat one cell in a second time window to gauge provider-side variance.
- Output: `results/r2-baseline.consolidated.json` + `results/R2-baseline-findings.md`.

## R3 — Concurrency sweep + fault injection (THROWAWAY accounts only)
- Concurrency sweep: for each pathway, N=20 at concurrency ∈ {1,2,4,8}. Watch okRate + p95
  degradation and the host spawn cap. Record where each pathway's throughput knees over.
- Fault injection: push a throwaway account to its rate-limit wall; capture the real
  error signature (classifyError taxonomy) + reset window text. NEVER on production accounts.
- Output: `results/R3-load-findings.md` + failure taxonomy table.

## R4 — Root-cause the anomalies (documented repros)
- codex-erroring-with-quota-free: reproduce, capture stderr signature; test hypotheses
  (spawn-cap acquire-timeout, exec-json parse fail, concurrency ceiling < quota).
- gemini 5s swap-timeout: locate in swap/failover path; repro with a slow gemini call.
- claude intermittent rate-limit: capture the 429/limit signature + reset text.
- Output: `results/R4-anomaly-repros.md`, each with exact repro + evidence.

## R5 — Redundant-pathway comparison + quality parity
- GPT-5.5 via pi vs codex: latency/cost/okRate head-to-head (R1b already shows ~11x latency
  gap) + OUTPUT QUALITY parity on the real prompts (do both produce correct classifications?).
- Output: `results/R5-redundant-comparison.md` with a recommended primary route per model.

## R6 — Synthesis + apply low-risk fixes
- Characterization matrix (pathway × {latency, cost, reliability, failure modes}).
- Failure-trigger catalog (from R3/R4).
- Evidence-backed routing recommendations.
- Apply low-risk fixes dark/reversible (config-gated). Interim stabilization (task #8):
  reroute contended components per evidence; address gemini swap-timeout. Stage higher-risk
  changes as reversible config for go/no-go. Route any instar SOURCE change through /instar-dev.
- Output: `results/R6-characterization-matrix.md` + recommendations; publish a private-view
  summary for the operator.
