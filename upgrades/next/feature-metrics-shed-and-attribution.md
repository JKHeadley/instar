# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**`/metrics/features` now reports an honest LLM-call count.** The metrics funnel
recorded circuit-open events — where the breaker refused the call and *no* LLM
ran (≈0ms, no token cost) — with the same `noop` outcome as a genuinely completed
call. On a saturated agent that made the numbers read as "≈99% of calls did
nothing," when in reality most of those rows were calls that never happened (the
0ms-latency confound).

The circuit-open path now records a distinct **`shed`** outcome, and the
per-feature rollup + totals expose **`shed`** and **`realCalls`** (= `calls −
shed`). `calls` is unchanged (backward-compatible total); `realCalls` is the
honest round-trip count, and `fireRate` now divides by `realCalls`.

Separately, the two highest-frequency internal callers (**InputGuard** and
**PresenceProxy**) now pass `attribution.component`, so their spend is attributed
instead of bucketing under `unlabeled` — advancing the spec's "every caller gets
tagged" goal. Remaining callers are a follow-up.

This is observability-only — it never gates, blocks, or alters any decision (same
safety property as the token ledger). Phase 1b of
`docs/specs/llm-feature-metrics-spec.md`.

## What to Tell Your User

Nothing to configure. The per-system LLM metrics are now more trustworthy: calls
the rate-limiter refused (where nothing actually ran) are counted separately from
real calls, so the numbers no longer make it look like the systems are doing
nothing when they're really just being throttled. Two of the busiest internal
checks also now show up by name instead of as "unlabeled."

## Summary of New Capabilities

- `shed` outcome + `realCalls` field on `/metrics/features` (per-feature and totals).
- `fireRate` now computed over `realCalls` (real round-trips), not all rows.
- Attribution labels for the InputGuard and PresenceProxy LLM callers.
