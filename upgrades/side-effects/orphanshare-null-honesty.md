# Side-Effects Review — Orphan Share Null Honesty

**Version / slug:** `orphanshare-null-honesty`
**Date:** `2026-07-29`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change fixes the benchmark-divergence orphan-share honesty path. `src/monitoring/BenchmarkDivergenceAnalyzer.ts` now passes `null` when the orphan-share denominator is zero, `src/core/benchmarkDivergenceCore.ts` branches on that null before the numeric threshold comparison and returns `partialReason: "orphan-share-unavailable"`, and `src/monitoring/FeatureMetricsLedger.ts` persists the new closed reason on the advisory finding read surface. Tests cover the core null branch, the analyzer producer path, ledger persistence, and the route allowlist.

## Decision-point inventory

- `computeVerdict` in `src/core/benchmarkDivergenceCore.ts` - modify - advisory benchmark-divergence verdict classification now distinguishes unavailable orphan share from clean orphan share before threshold comparison.
- `BenchmarkDivergenceAnalyzer` orphan-share producer - modify - zero decided denominator now produces `null` instead of fabricated `0`.
- `benchmark_divergence_findings` read surface - modify - persists and serves a closed `partialReason` enum for advisory findings.

---

## 1. Over-block

No block/allow surface - over-block not applicable. The changed verdict is advisory and does not block messages, actions, routing, retention, or execution. The concrete behavior change is that a benchmark finding which previously could be `aligned` or `divergent-*` with `decided_total = 0` and enough settled grades now becomes `partial` with `partialReason: "orphan-share-unavailable"`.

---

## 2. Under-block

No block/allow surface - under-block not applicable. Remaining advisory limitations: the change only addresses the orphan-share denominator being unavailable. It does not reinterpret other inconsistent rollup shapes, and it does not attempt to repair the upstream rollup row. Those cases remain represented by the existing evidence fields such as `gradedN`, `unknownShare`, and the verdict ladder's other preconditions.

---

## 3. Level-of-abstraction fit

This is at the right layer. The analyzer owns production of the pool-merged orphan-share input, while the pure verdict ladder owns the comparison and must therefore branch on null before numeric threshold logic. Persisting the closed reason in the ledger is also the right layer because the API can then surface the reason without recomputing or accepting peer-authored text.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No - this change has no block/allow surface.

The verdict remains an advisory benchmark-divergence finding. It does not gate user messages, external operations, session lifecycle, dispatch, or retention. The only decision point changed is the detector's own content-free advisory classification.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. This is a structural denominator invariant: zero decided records cannot support an orphan-share rate. The closed partial reason reports that invariant instead of making a judgment over competing live signals.

---

## 5. Interactions

- **Shadowing:** The null branch runs before the existing orphan-share numeric comparison. That ordering is required because JavaScript would otherwise coerce null during comparison.
- **Double-fire:** No second writer is added. The analyzer still writes one benchmark finding per `(task, decision point, model)` key through the existing upsert.
- **Races:** The additive SQLite column is added at ledger open with `PRAGMA table_info` guarding. Existing rows default to null and are overwritten by the next idempotent analyzer upsert.
- **Feedback loops:** The advisory finding can seed chronic-streak logic exactly like other `partial` verdicts. No new loop, cadence, or autonomous action is introduced.

---

## 6. External surfaces

The benchmark-divergence API can now include `partialReason` on finding rows. This is a content-free closed enum and is accepted through the existing peer clamp only when it matches the local enum. Persistent state changes by adding nullable `partial_reason` to `benchmark_divergence_findings`; no destructive migration or data rewrite is required. No operator-facing actions are added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface - not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read.** Benchmark-divergence already merges peer findings through `GET /benchmark-divergence?scope=pool` and clamps peer finding fields locally. The new `partialReason` follows that same merged-read path and is a closed enum, not replicated free text. The feature emits no user-facing notices, holds only advisory ledger state, and generates no URLs.

---

## 8. Rollback cost

Hot-fix release: revert the code and tests. The nullable `partial_reason` column can remain harmlessly in existing SQLite databases because older code ignores unknown columns and writes do not depend on it. No agent state repair is needed. During rollback propagation, users may temporarily see less specific benchmark-divergence partial findings or the prior fabricated-zero behavior on agents that have not updated.

---

## Conclusion

Clear to ship as a Tier 1 fix. The review did not identify a new block/allow authority, multi-machine strand, operator surface, or destructive migration. The main risk is API shape expansion, controlled by a closed enum and covered by the route allowlist test.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

The change does not touch outbound or inbound messaging, dispatch, session lifecycle, context recovery, coherence gates, trust levels, or a sentinel/guard/watchdog component. It modifies an advisory detector verdict and its read surface only.

---

## Evidence pointers

- `./node_modules/.bin/vitest run tests/unit/benchmarkDivergenceCore.test.ts tests/unit/FeatureMetricsLedger-byModel.test.ts tests/unit/BenchmarkDivergenceAnalyzer.test.ts tests/integration/benchmark-divergence-routes.test.ts` - 4 files passed, 86 tests passed.
- `./node_modules/.bin/tsc --noEmit` - passed.
- `rg -n "orphanShare" src tests -S` - only one numeric comparison site remains, in `computeVerdict`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect - not applicable.
