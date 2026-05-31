# Side-Effects Review — Per-feature LLM metrics (Phase 1a)

**Slug:** `llm-feature-metrics`
**Date:** 2026-05-31
**Author:** echo
**Spec:** `docs/specs/llm-feature-metrics-spec.md` (review-convergence + approved by Justin, Telegram 13435)

## Summary of the change

Adds a read-only per-feature LLM observability ledger + endpoint, so every gate/
sentinel's cost (tokens, latency) and hit-rate becomes a tracked number and tuning
is evidence-based. **Phase 1a: the store + route only — no funnel edit, so zero
collision with the open #638** (which restructures the same `evaluate()` with
bounded-wait). Phase 1b (after #638) adds the ~3-line funnel tap that feeds it.

**Files changed (source):**
- `src/monitoring/FeatureMetricsLedger.ts` — NEW. SQLite-backed, read-mostly, modeled
  on TokenLedger (opened via `NativeModuleHealer.openWithHealSync` for ABI resilience).
  `record()` / `recordEvent()` append; `byFeature()` / `summary()` roll up per feature
  (calls, tokens, fired/noop, fire-rate, p50/p95 latency, wait-stats). Never gates.
- `src/server/AgentServer.ts` — construct the ledger in its OWN try/catch inside the
  stateDir block (cascade-isolated, mirroring FrameworkIssueLedger); add the field +
  import; pass `featureMetricsLedger` into the route context.
- `src/server/routes.ts` — `GET /metrics/features` (mirrors `/tokens/summary`):
  503-stub on a null ledger; `?sinceHours=` / `?feature=` filters; add the ctx type field.
- `src/scaffold/templates.ts` — Agent Awareness: a "Per-Feature LLM Metrics" read-surface
  blurb in the template Capabilities (new agents).
- `src/core/PostUpdateMigrator.ts` — Migration Parity: an idempotent, content-sniffed
  (`/metrics/features`) `migrateClaudeMd` block (existing agents). Marker shared with the
  template → no double-patch.

**Files changed (docs/tests):**
- `docs/specs/llm-feature-metrics-spec.md` (+ `.eli16.md`).
- `tests/unit/FeatureMetricsLedger.test.ts` (+8), `tests/unit/PostUpdateMigrator-metricsFeatures.test.ts` (+3),
  `tests/integration/metrics-features-routes.test.ts` (+3), `tests/e2e/metrics-features-lifecycle.test.ts` (+3),
  and the `/metrics/features` registration in `tests/unit/feature-delivery-completeness.test.ts`.

## Blast radius

Confined to a new ledger + one new read route + CLAUDE.md awareness text. **No existing
gate, sentinel, job, or flow changes behavior.** The ledger is read-only observability
(same guarantee as TokenLedger); in Phase 1a nothing even writes to it in production yet
(the funnel tap is Phase 1b), so the live effect is purely: a new `/metrics/features`
endpoint that returns an empty-but-alive rollup.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| `GET /metrics/features` | 404 (no route) | 200 + per-feature rollup (empty until Phase 1b) |
| ledger init fails / no stateDir | — | route 503-stubs (graceful, like /tokens) |
| existing LLM gates (tone, coherence, stop) | run as-is | **unchanged** (no funnel edit) |
| new agent init | no metrics awareness | template Capabilities mentions /metrics/features |
| existing agent update | no metrics awareness | migrateClaudeMd appends it once (idempotent, no double-patch) |

## Risks considered

- **Collision with #638?** None — Phase 1a does not touch `CircuitBreakingIntelligenceProvider`
  or any gate file #638 edits. The tap (Phase 1b) is built on top of #638's merged funnel.
- **Observability breaking the path it observes?** No — `record()` swallows write errors;
  the ledger is a side-channel, never a gate (Close the Loop: measurement must not become a blocker).
- **ABI / native-module?** Opened via the same `NativeModuleHealer` path as TokenLedger.
- **Double-patch a fresh agent?** No — template + migration share the `/metrics/features`
  content-sniff marker; covered by an explicit test.
- **Unbounded growth?** Same retention approach as TokenLedger (follow-up); Phase 1a writes
  nothing in production yet.

## Migration parity

Handled: template (new agents) + content-sniffed `migrateClaudeMd` (existing agents),
registered in `feature-delivery-completeness` `legacyMigratorSections` (a read-surface like
`/codex/usage` / `/tokens`, not a framework-shadowed user capability). No config default,
hook, or skill changed.

## Tests

3-tier, all green: unit (ledger + migration), integration (route 200/503/filter), E2E
(feature-is-alive on the real AgentServer init: 200 not 503, auth-gated, read-only).
`npm run lint` (tsc + destructive/LLM/URL-log/codex-drift) clean.
