---
title: Benchmark-Divergence Detector
description: An observe-only detector that compares each enrolled decision point's real per-model grade-rate against the benchmark's predicted pass-rate — noise-aware on both sides, precondition-first, advisory-only. Ships dark behind benchmarkDivergence.
---

The [LLM-Decision Quality Meter](/features/decision-quality-meter) records how the agent's internal
LLM decisions actually turn out (right / wrong / unknown). The benchmark
([INSTAR-Bench](/features/llm-routing-bench)) predicts, per (task, model), how well each model
*should* do. The **Benchmark-Divergence Detector** is the feedback loop between them: when real life
disagrees with the prediction — exactly the signal worth acting on — it records an advisory finding
with ranked questions, instead of letting the grade data age out unlearned-from.

## How it decides

- **Per (decision-point × model), settled grades only.** The real grade-rate uses right/wrong
  outcomes; not-yet-known decisions are counted separately (`unknownShare` over ALL recorded
  decisions), so a heavily-ungraded stream can never sail through as evidence.
- **Noise-aware on BOTH sides.** A divergence flags only past
  `max(threshold, wilson95(real), wilson95(bench))` — a 10-case battery carries ±~0.26 of sampling
  noise at p=0.5 and cannot manufacture divergence.
- **Precondition-first.** If the benchmark tested a stale copy of the prompt (template-hash
  mismatch), the hash can't be verified, the analysis window mixes prompt identities, or the mirror
  itself is stale/missing — the verdict is `precondition-failed`, suppressing divergent AND aligned.
  A stale benchmark never blames (or credits) a model.
- **Direction-split.** `divergent-worse` asks: enough context? right prompt? representative
  battery? `divergent-better` leads with "is the grade-rate inflated?" — over-performance is the
  signature of a lenient grade stream, never a "promote this model" signal.
- **Advisory only.** Every finding carries `advisory: true`; nothing may gate, route, or escalate
  on one except as a signal into a proper authority.

## Across machines

The analysis pass runs on the **serving-lease holder only** and pool-collects every machine's
matured-window aggregates through strict type/volume clamps (a lying peer is bounded, excluded, and
named — never silently merged). An offline machine makes the finding `partial`, re-checked next
pass; a finding stuck non-actionable for consecutive cycles flips `chronic: true` and names why —
a permanently stale mirror or a persistently-offline machine may not hide forever. A per-machine
loss-accounting watermark counts (out loud) any day that ages past retention having never been
analyzed.

## Reading and driving it

- `GET /benchmark-divergence` — findings + analyzer/mirror status + summary (`?scope=pool` merges
  peers' clamped findings). Returns 503 while dark.
- `POST /benchmark-divergence/analyze` — one lease-gated, rate-limited, idempotent pass. The
  built-in `benchmark-divergence-analysis` job (ships `enabled: false`) drives the daily cadence.
- `GET /benchmark-divergence/rollup-aggregates` — the peer-collection route (range clamped by the
  serving peer).

## Safety posture

Ships **dark on the fleet, live-in-dryRun on a development agent** (`benchmarkDivergence.enabled`
omitted ⇒ dev-agent gate; `dryRun: true` ⇒ zero detector-owned durable writes). The per-model
rollup substrate (`decision_quality_rollup_by_model`) is maintained METER-side inside the annotate
chokepoint — exactly as enabled as the meter's grading — so a later detector enable has history
rather than a cold-start hole; flipping the detector off never changes the meter's stores or
retention by one byte.
