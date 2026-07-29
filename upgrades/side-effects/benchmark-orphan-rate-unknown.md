# Side-Effects Review — Benchmark orphan-rate unknown verdict

**Version / slug:** `benchmark-orphan-rate-unknown`
**Date:** `2026-07-29`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

The benchmark divergence detector now distinguishes a measured zero orphan rate from an unmeasurable orphan rate. `VerdictInput.orphanShare` becomes `number | null`; `null` returns `partial` with `partialReason: orphan-rate-unknown` before aligned or divergent verdicts can be emitted. The analyzer computes `null` when the pool-merged decided denominator is unavailable, and the finding ledger/API surface carries a nullable `partialReason` field. Touched runtime files: `src/core/benchmarkDivergenceCore.ts`, `src/monitoring/BenchmarkDivergenceAnalyzer.ts`, and `src/monitoring/FeatureMetricsLedger.ts`.

## Decision-point inventory

- `computeVerdict` benchmark divergence ladder — modified — Step 7 now treats unknown orphan rate as a non-actionable partial verdict.
- `BenchmarkDivergenceAnalyzer.runPass` orphan-share calculation — modified — empty decided denominator now emits `null` rather than a fabricated `0`.
- `FeatureMetricsLedger` benchmark findings persistence — modified — stores and reads the explanatory `partialReason`.

## 1. Over-block

No block/allow surface. This can suppress an actionable benchmark finding into `partial` when the orphan denominator is missing but enough graded rows exist. That is intentional: the rate is not measurable, so aligned/divergent would be dishonest.

## 2. Under-block

If a denominator is present but wrong, this change does not prove it is correct; it only prevents the specific empty-denominator collapse. Existing aggregate clamps still handle implausible peer rows, and the regression test covers the join-miss shape where `decided_total = 0` while graded rows meet `minSample`.

## 3. Level-of-abstraction fit

This belongs in the pure verdict core because it is part of the detector's evidence ladder, not a display-only concern. The analyzer owns measurement (`number` vs `null`); the core owns the consequence; the ledger owns durable explanation.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The benchmark divergence detector remains observe-only and every finding remains `advisory: true`. This change reduces false actionable signals by making an unknown orphan rate non-actionable.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. This is an enumerable data-validity invariant: an orphan share with no denominator is unknown, not zero.

## 5. Interactions

- **Shadowing:** The new partial gate runs before evidence floors and divergence comparison, so it intentionally shadows aligned/divergent when orphan rate is unknown.
- **Double-fire:** No duplicate actor; `partialReason` is a nullable annotation on the same finding row.
- **Races:** No new concurrency path. Analyzer remains lease-gated and writes through the existing idempotent upsert.
- **Feedback loops:** Chronic streak behavior remains unchanged because `partial` was already non-actionable.

## 6. External surfaces

The `GET /benchmark-divergence` finding envelope gains optional `partialReason`. Existing consumers reading `verdict` and `orphanTainted` continue to work; readers can now tell `orphan-rate-unknown` from `orphan-share-exceeded`. Persistent state gains nullable `benchmark_divergence_findings.partial_reason`, added idempotently for existing databases.

No operator-facing actions. No Telegram/Slack/GitHub/Cloudflare behavior. No generated URLs.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read: benchmark divergence already supports local and pool findings through `GET /benchmark-divergence?scope=pool`, and peer findings are clamped through `clampPeerFinding`. The new `partialReason` field is allowlisted and enum-clamped for peer merge. No user-facing notices, no topic-transfer state, no generated URLs.

## 8. Rollback cost

Hot-fix release: revert the code and tests. The nullable `partial_reason` column can remain harmlessly unused; no data cleanup is required. During rollback, unknown orphan rates would again risk collapsing to fabricated zero until the revert is replaced.

## Conclusion

The review found the main side effect: fewer actionable benchmark findings when orphan-rate measurement is missing. That is the intended honesty improvement. The change is clear to ship with the targeted regression test and typecheck passing.

## Second-pass review (if required)

**Reviewer:** `not required`
**Independent read of the artifact:** `not required`

This change does not touch outbound messaging, session lifecycle, dispatch, context exhaustion, coherence gates, or a guard/watchdog/sentinel path.

## Evidence pointers

- `npx vitest run tests/unit/benchmarkDivergenceCore.test.ts tests/unit/BenchmarkDivergenceAnalyzer.test.ts tests/integration/benchmark-divergence-routes.test.ts`
- `npx tsc --noEmit`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
