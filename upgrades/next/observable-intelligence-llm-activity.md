<!-- bump: minor -->
<!-- change_type: feat -->

## What Changed

The per-feature LLM metrics ledger now records, for every call the system makes on its own behalf (sentinels, gates, reflectors, background checks), **which provider + model actually ran it** and **whether the check acted (fired) or found nothing (noop)** — closing two long-standing blind spots: the `model` column was never populated, and the `fired` verdict was deferred to a "Phase 2" that never shipped, so codex/gemini calls were unattributable and every completed call read as a no-op. Recording is enforced at the single funnel (`CircuitBreakingIntelligenceProvider`) via two additive, optional seams on `IntelligenceOptions` — `onModel` (every provider surfaces its resolved model/framework, independent of token usage) and `classifyVerdict` (the caller classifies act-vs-no-act). A new **LLM Activity** dashboard tab renders it in plain language over a 24h/7d/30d window. Bounded retention (default 30 days, `monitoring.featureMetrics.retentionDays`) ages the audit trail out so it is never hoarded forever.

## What to Tell Your User

You can now audit what your agent's "autopilot" is actually doing: open the **LLM Activity** dashboard tab to see, per check, which AI provider ran it, how often it acted on something vs. found nothing, how often it was skipped to save rate limits, and what it cost — over time. This is the new *Observable Intelligence* standard: no autonomous AI action the system takes is allowed to be invisible. Nothing for you to do; it takes effect on the next restart.

## Summary of New Capabilities

- `/metrics/features` rows now include `frameworks[]`, `models[]`, real `fired`/`fireRate`, and `shed` — answering "which provider ran this sentinel?" and "is it doing real work or just being skipped?".
- New **LLM Activity** dashboard tab (read-only) over a selectable window.
- `IntelligenceOptions.onModel` + `classifyVerdict` seams; every provider (Claude/Codex/Gemini/Pi/InteractivePool) surfaces its model/framework; `MessageSentinel` + `CommitmentSentinel` classify their verdicts.
- Bounded retention via `FeatureMetricsLedger.pruneOlderThan` + `monitoring.featureMetrics.retentionDays` (default 30).
- New constitutional standard *Observable Intelligence — No Autonomous LLM Action Is Unauditable* (proposed, pending ratification) + spec `docs/specs/observable-intelligence.md`.

## Scope (honest)

Provider/model attribution + the fired/noop verdict are recorded for all providers. Per-call **token cost** is captured where the provider surfaces it (Claude, Pi); codex/gemini exec output carries no usage block, so their per-call tokens stay null (model/framework + outcome are still recorded; account-level codex cost is visible via `/codex/usage`) — per-call token parsing for those via their `--json` modes is a bounded follow-up. Read-only observability throughout: it never gates, blocks, or mutates the path it observes.

## Evidence

`tests/unit/FeatureMetricsLedger.test.ts` (12, +4: framework rollup, prune, idempotent column add), `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` (19, +7: onModel/classifyVerdict/error-path attribution + real-ledger rollup), `tests/integration/metrics-features-routes.test.ts` (+1: provider/model/fired through the route), `tests/e2e/metrics-features-lifecycle.test.ts` green; no-silent-fallbacks ratchet + feature-delivery-completeness parity green; `tsc` clean.
