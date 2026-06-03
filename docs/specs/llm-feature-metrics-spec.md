---
title: "Per-feature LLM metrics — measure every gate/sentinel so tuning is evidence-based"
date: 2026-05-31
author: echo
parent-principle: "Observability — you can't tune what you can't see"
review-convergence: internal-plus-conformance-2026-05-31
approved: true
approved-by: Justin
approved-via: Telegram topic 13435 (2026-05-31 — presented the metrics plan: per-system cost + hit-rate + effectiveness via one funnel instrumentation point, phased; Justin "Perfect please proceed". The motivating directive: "a plan to track all of the required metrics that will enable us to evaluate the effectiveness of all of the systems … inform how we should tune them … tone them down or up or alter the way they operate.")
eli16-overview: llm-feature-metrics-spec.eli16.md
---

# Per-feature LLM metrics

## Problem

Instar runs a growing set of LLM-driven safety/quality systems — sentinels and gates (MessagingToneGate, CoherenceReviewer/CoherenceGate, UnjustifiedStopGate, ContextualEvaluator, the External-Operation gate, and more). Each spends tokens and adds latency, and each is *supposed* to catch something. But there is no per-system measurement: we cannot answer "what does this gate cost, how often does it actually fire, and is it catching real problems or crying wolf?" The cost only became visible when the aggregate surfaced as a rate-limit nobody had attributed to any specific gate. Tuning (the just-shipped keep-vs-thin list) is therefore *estimated*, not measured.

This is the **Close the Loop** standard applied to our own safety machinery: a gate deployed and never measured is a loop left open — it runs forever unexamined. The fix is to make every system's cost and effectiveness a tracked, re-surfaced number, so "tone it down / up / alter it" is an evidence decision.

## The single-funnel insight

Every LLM-driven system flows through one chokepoint: the shared `IntelligenceProvider` that `CircuitBreakingIntelligenceProvider` wraps (`evaluate(prompt, options)`). The signal-hooks call the server; the server runs the LLM through this one provider. So a single instrumentation point captures cost + outcome for *all* LLM systems — no per-system wiring — exactly the single-funnel pattern of `SafeFsExecutor` / `SafeGitExecutor`. This extends the existing read-only `TokenLedger` (per-session token observability) to a per-**feature** view.

## What is measured

Per LLM call (recorded at the funnel):
- **feature** — the calling system's id (from `IntelligenceOptions.label` / a required `feature` tag; calls without one are bucketed `unlabeled` and flagged so every caller gets tagged).
- **Cost** — input/output tokens (when the provider reports them), wall latency.
- **Outcome** — the verdict class the caller maps its result to: `fired` (blocked/flagged/acted) vs `noop` (allow/no-change) vs `error`. → **hit-rate**.
- **Context** — model, circuit state at call time, and (post-#638) whether the call **waited** for a rate-limit window + wait duration + wait outcome (so #638's bounded-wait is measured too).

Programmatic guards (no LLM — dangerous-command, prompt-guard, free-text guard): a lighter `recordEvent(feature, outcome)` (invocation + verdict counts, no token cost). Volume + hit-rate still tell us whether the guard earns its place.

**Effectiveness (Phase 2)** — correlate each verdict with what happened next: a `fired` that was overridden / turned out benign = false-positive signal; a `noop` followed by the bad thing it should have caught = false-negative signal. Each record carries a `verdictId`; downstream events (user override, action-proceeded-cleanly, a later correction) reference it. Phase 1 ships the cheap proxies (fire-rate, override-rate via existing correction signals); Phase 2 deepens the correlation.

## Architecture

- **`FeatureMetricsLedger`** (`src/monitoring/FeatureMetricsLedger.ts`) — SQLite-backed, read-mostly, modeled on `TokenLedger`. `record(entry)` / `recordEvent(...)` append rows; `summary()` / `byFeature()` produce per-feature rollups (calls, tokens, p50/p95 latency, fire-rate, est. cost, wait-stats). Never gates, blocks, or mutates source — pure observability (like TokenLedger).
- **Read endpoint** — `GET /metrics/features` (+ `?feature=` / `?sinceHours=`) returns the per-feature rollup; Bearer-auth. (Sibling of `/tokens/summary`.)
- **Dashboard tab** (later) — the human read surface; until then the endpoint + a digest.
- **Periodic review job** (Phase 2) — *this is the Close the Loop cadence*: re-surfaces each system's cost + hit-rate + effectiveness on a schedule and flags candidates: expensive+low-hit → **thin**; high-fire-but-overridden → **rework**; never-fires → **consider removing**; high-value → **keep/strengthen**. Off by default; ships on the graduated-rollout track.

## Phasing (and #638 coordination)

- **Phase 1a (this PR):** `FeatureMetricsLedger` + `GET /metrics/features` + 3-tier tests. The ledger is exercised directly via `record()`/`recordEvent()` in tests, and the endpoint is "alive" (200, real rollup of whatever has been recorded). **No funnel edit — zero collision with the open #638**, which restructures the same `evaluate()` with bounded-wait.
- **Phase 1b (after #638 merges):** add the ~3-line tap inside the *post-#638* `CircuitBreakingIntelligenceProvider.evaluate()` so production calls flow into the ledger, recording the wait-fields #638 introduces. Small, on top of the hardened funnel — built against its final shape, not rebased onto it.
- **Phase 2:** effectiveness correlation (verdictId ↔ downstream outcomes) + the periodic review job (the cadence).
- **Phase 3 (separate spec):** generalize the review cadence into the shared **recurring-review substrate** that commitments + feature-maturation + this metrics-review all plug into — the Layer-2 realization of Close the Loop.

## Testing (Phase 1a)

- **Unit** (`tests/unit/FeatureMetricsLedger.test.ts`): `record`/`recordEvent` persist; `byFeature` rollup math (calls, token sums, latency percentiles, fire-rate); `unlabeled` bucketing; idempotent re-open on an existing db; SafeFsExecutor-based tmpdir cleanup.
- **Integration** (`tests/integration/metrics-features-routes.test.ts`): `GET /metrics/features` returns 200 + the rollup; Bearer-auth enforced; `?feature=` filter.
- **E2E** (Phase-1 "feature is alive"): the route is wired in the production server init and returns 200 (not 503).

## Non-goals / risk

Read-only observability; it never gates, blocks, or alters any flow (same guarantee as TokenLedger). The single guarded risk is unbounded growth — bounded by the same retention approach as TokenLedger. No runtime behavior change to any existing gate in Phase 1a.
