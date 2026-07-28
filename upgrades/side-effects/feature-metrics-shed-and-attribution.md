# Side-Effects Review — FeatureMetrics: honest call counts (`shed`) + caller attribution

**Version / slug:** `feature-metrics-shed-and-attribution`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

Two refinements to the per-feature LLM metrics funnel (Phase 1b of
`docs/specs/llm-feature-metrics-spec.md`), both making `/metrics/features` an
honest spend measure:

1. **`shed` outcome** — `CircuitBreakingIntelligenceProvider.evaluate()` recorded
   the circuit-OPEN path (no LLM call ran, ~0ms) as `'noop'`, identical to a
   completed call. `FeatureMetricsLedger` therefore counted breaker-shed load as
   completed work, so `calls` read ~99% "noop" when most rows were no-calls (the
   0ms-latency confound). The circuit-open path now records a distinct `'shed'`
   outcome; the rollup/summary expose `shed` + `realCalls` (= `calls − shed`);
   `calls` is unchanged (backward-compatible total) and `fireRate` now divides by
   `realCalls`.
2. **Attribution** — the spec requires "every caller gets tagged," but the two
   highest-frequency callers passed no `attribution.component`, so they bucketed
   under `unlabeled`. Added `attribution: { component: 'InputGuard' }` at
   `InputGuard`'s review call, and a default `{ component: 'PresenceProxy' }` in
   `PresenceProxy.callLlm` (caller-supplied attribution still wins).

Files: `src/core/CircuitBreakingIntelligenceProvider.ts`,
`src/monitoring/FeatureMetricsLedger.ts`, `src/core/InputGuard.ts`,
`src/monitoring/PresenceProxy.ts`,
`tests/unit/CircuitBreaking-feature-metrics-tap.test.ts`.

## Decision-point inventory

- `CircuitBreakingIntelligenceProvider.evaluate → recordMetric (circuit-open path)` — modify — records `'shed'` instead of `'noop'` when no call ran.
- `FeatureMetricsLedger.byFeature/summary rollup` — modify (additive) — new `shed` + `realCalls` fields; `fireRate` denominator changes to `realCalls`.
- `InputGuard` LLM review attribution — add — passes `component: 'InputGuard'`.
- `PresenceProxy.callLlm` attribution — add — default `component: 'PresenceProxy'`.

This change has **no block/allow surface** — it is read-only observability plus
metadata labels passed through an existing call. It never gates, blocks, throttles,
or alters control flow.

## 1. Over-block

No block/allow surface — over-block not applicable. The metrics ledger never
rejects anything; attribution is a label on an existing call.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Correct layer. This is observability (a detector/recorder), deliberately at the
single funnel chokepoint the spec identifies (`CircuitBreakingIntelligenceProvider`).
It does not own authority and does not duplicate a higher gate — it *feeds*
`/metrics/features`, the existing read surface. The `shed` distinction lives where
the circuit decision is already made, so no new decision logic is introduced —
only an honest label on an outcome that already happened.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

It produces signal (metrics rows) consumed by the read-only `/metrics/features`
surface. No blocking authority, brittle or otherwise.

## 5. Interactions

- **Shadowing:** none. `recordMetric` is a side-channel after the breaker
  decision; reordering is impossible (it records the decision already made).
- **Double-fire:** none. Exactly one metric row per `evaluate()` as before; only
  the recorded `outcome` string changed on the circuit-open path.
- **Races:** none new. `FeatureMetricsLedger` writes are unchanged (WAL SQLite,
  try/catch-swallowed). `PresenceProxy.callLlm` builds a local `opts` object — no
  shared-state mutation (the caller's `options` is spread, not mutated).
- **Feedback loops:** none. Metrics are observe-only; they never feed back into
  the breaker or any gate.

## 6. External surfaces

- **Other agents / install base:** the `/metrics/features` JSON response gains
  `shed` + `realCalls` fields (per-feature and in `totals`). Purely additive —
  existing consumers reading `calls`/`noop`/`fired` are unaffected (`calls`
  semantics preserved). The dashboard tab tolerates extra fields.
- **External systems:** none (no Telegram/Slack/GitHub/Cloudflare surface).
- **Persistent state:** `feature_metrics` SQLite rows now may carry
  `outcome='shed'`. No schema change (`outcome` is free-text TEXT); old rows are
  unaffected; no migration required.
- **Timing:** none.

## 7. Rollback cost

Pure code change — revert and ship a patch. The only persistent residue is
`outcome='shed'` rows in `feature_metrics`; after a revert those rows simply stop
being written and any existing ones are harmless (queries that don't know `shed`
ignore them; `calls` still counts them). No data migration, no agent-state repair,
no user-visible regression during the rollback window.

## Conclusion

This review produced no design changes — the change is observability-only,
additive, and squarely within the approved `llm-feature-metrics-spec` (Phase 1b).
The `shed`/`realCalls` split is the fix for the misleading "99% noop" reading; the
attribution labels advance the spec's stated "every caller gets tagged" goal for
the two highest-volume callers (remaining callers are a follow-up). Build is clean
and the metrics test suites (unit tap, ledger, integration, e2e) plus
InputGuard/PresenceProxy suites are green (154 tests). Clear to ship.

## Evidence pointers

- `pnpm build` clean; `vitest run` green across the feature-metrics + InputGuard +
  PresenceProxy suites (2026-06-03).
- Durable patch: `.planning/resource-ledger-impl/slice-a-full.patch` (agent home).
