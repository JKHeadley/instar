---
title: LLM-Decision Quality Meter
description: An observe-only quality substrate over the agent's internal LLM decisions — uniform provenance recording plus deterministic right/wrong/unknown outcome grading, read at GET /decision-quality. Ships dark/dry-run behind provenance.uniformSeam.
---

Instar has long had a *cost* meter for its AI decisions — which model ran, how many tokens, how fast
(`feature_metrics`). The **LLM-Decision Quality Meter** adds the missing half: a *quality* meter
that records WHAT each enrolled high-stakes decision saw and chose, then checks afterward — against
real evidence — whether the call turned out right. It MEASURES decisions; it never gates, blocks, or
delays them.

## The three pieces

- **Correlation spine.** Every enrolled decision mints a replay-proof correlation id, so cost,
  provenance, and outcome all thread back to one decision. The caller's data is never mutated, and a
  failed attempt's cost can never be double-counted.
- **Uniform provenance.** `JudgmentProvenanceLog` recording is extended past its original two
  callsites through one chokepoint, `DecisionQualityRecorderImpl`, with a full census of the
  decision-point surface (`provenanceCoverage`) and a shrink-only coverage ratchet so enrollment
  can only grow.
- **Outcome grading.** A deterministic, evidence-triggered pass stamps each recorded decision
  `right` / `wrong` / `unknown` as reality's evidence matures — did the killed process come back?
  did the "done" run actually finish? Grading is rule-based (never an LLM re-judging an LLM in this
  build), idempotent, and budget-bounded. The first graded customer is the external-hog kill
  decision, whose per-candidate decisions persist durably in `ExternalHogDecisionStore`
  (grade-on-supersede: a later scan's evidence grades the earlier decision).

## Reading it

- `GET /decision-quality` — the read surface: per-decision-point grade rates aggregated
  evidence-strength-first (proof-like grades are never blended with heuristic ones), an explicit
  `insufficient-evidence: true` marker under the minimum sample, census debt (enrolled vs pending
  points), and rejection counters. `?scope=pool` merges machine-local data across a multi-machine
  pool through a strict field allowlist. Returns 503 while the seam is dark.
- `POST /decision-quality/grade-pass` — runs one deterministic grading pass (keyset cursor,
  idempotent, budget-bounded). The built-in `llm-decision-grading` job template (ships
  `enabled: false`) drives it on a cadence.

## Safety posture

Ships **dark + dry-run** behind `provenance.uniformSeam` (dev-gated; `dryRun` defaults true, which
suppresses every durable write while keeping metadata-only would-write logging). Nothing changes any
decision; nothing grades durably until the seam is deliberately flipped after soak. Two live
fixes shipped alongside: the dashboard file browser can no longer serve or edit the decision-provenance
log, and the backup manager's per-file exclusion can no longer be bypassed (including on restore).
