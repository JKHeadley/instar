# Upgrade Guide Fragment — Orphan Share Null Honesty

## What Changed

The benchmark-divergence detector no longer treats a zero decided-record denominator as a clean orphan share of zero. When settled grades are present but orphan-share cannot be measured, the advisory finding now becomes `partial` with `partialReason: "orphan-share-unavailable"` before any numeric threshold comparison runs.

The over-threshold orphan path also names its reason as `partialReason: "orphan-share-over-threshold"`. The finding ledger stores the closed partial reason in a nullable additive column, and the benchmark-divergence API exposes it through the same content-free peer clamp used for the rest of the finding envelope.

## What to Tell Your User

The benchmark-divergence readout is more honest when its evidence is internally inconsistent: it now says the comparison is partial instead of presenting a model verdict from an unavailable orphan-share rate.

## Summary of New Capabilities

- Distinct partial reason for unavailable orphan-share evidence.
- Closed partial-reason field on benchmark-divergence findings and pool reads.
- Additive SQLite migration for existing benchmark finding ledgers.

## Evidence

- `./node_modules/.bin/vitest run tests/unit/benchmarkDivergenceCore.test.ts tests/unit/FeatureMetricsLedger-byModel.test.ts tests/unit/BenchmarkDivergenceAnalyzer.test.ts tests/integration/benchmark-divergence-routes.test.ts` passed: 4 files, 86 tests.
- `./node_modules/.bin/tsc --noEmit` passed.
- The pre-commit hook ran the full repository lint chain and accepted the Tier 1 instar-dev trace.
