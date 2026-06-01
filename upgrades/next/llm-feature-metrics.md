# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

New read-only observability: **per-feature LLM metrics**. A new
`FeatureMetricsLedger` (SQLite, like the token ledger) plus `GET
/metrics/features` let you see what each LLM-driven gate/sentinel actually
costs (tokens, latency) and how often it fires — so tuning them is evidence-
based (which to thin, which to strengthen) instead of guessed.

This is **Phase 1a**: the store + endpoint. It changes no existing gate's
behavior and writes nothing in production yet — the single funnel tap that
feeds it lands in **Phase 1b**, on top of the in-flight rate-limit-resilience
change (#638), so the two don't collide.

## What to Tell Your User

Nothing required. If asked: I can now report, per safety check, how much it costs
and how often it fires — which is what lets us tune the checks with real data
instead of guesses.

## Summary of New Capabilities

- `GET /metrics/features` (`?sinceHours=` / `?feature=`) — per-feature rollup:
  calls, tokens, fired/no-op, fire-rate, p50/p95 latency, wait-stats.
- `FeatureMetricsLedger` — read-only per-feature LLM observability store.
- Agents learn about it via the CLAUDE.md template (new) + migration (existing).

## Evidence

- Spec: `docs/specs/llm-feature-metrics-spec.md` (+ `.eli16.md`), review-convergence
  + approved by Justin (Telegram 13435, 2026-05-31).
- Tests (3-tier): `tests/unit/FeatureMetricsLedger.test.ts`,
  `tests/unit/PostUpdateMigrator-metricsFeatures.test.ts`,
  `tests/integration/metrics-features-routes.test.ts`,
  `tests/e2e/metrics-features-lifecycle.test.ts` (feature-is-alive: 200 not 503).
  `npm run lint` clean.
