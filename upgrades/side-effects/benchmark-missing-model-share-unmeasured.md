# Side-Effects Review — Benchmark missing-model share unmeasured state

**Version / slug:** `benchmark-missing-model-share-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`BenchmarkDivergenceAnalyzer.summary()` now returns null for
`missingModelShare` when the matured window contains zero decisions. Measured
windows retain the existing ratio.

## Decision-point inventory

- Benchmark summary evidence sufficiency — modified — a share requires at
  least one recorded decision.
- Divergence verdict computation — passed through unchanged.

## 1. Over-block

No action is blocked. The summary is a read-only operator surface.

## 2. Under-block

No detector condition changes. Null distinguishes an empty matured window from
a measured zero-percent missing-model share.

## 3. Level-of-abstraction fit

The analyzer owns the matured-window aggregation and is the first layer that
knows whether the ratio has a denominator. The HTTP route passes its summary
through without reconstructing that evidence.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The benchmark-divergence endpoint remains advisory observability. Verdict
generation and preconditions are untouched.

## 4b. Judgment-point check

No heuristic is added. The change applies the mathematical requirement that a
share needs a non-empty denominator.

## 5. Interactions

- **Shadowing:** null replaces only the empty-window zero fallback.
- **Double-fire:** no events or notices are emitted.
- **Races:** ledger reads and window selection are unchanged.
- **Feedback loops:** the summary does not control analysis or routing.

## 6. External surfaces

`GET /benchmark-divergence` can now return
`summary.missingModelShare: null` when the matured window has no decisions.
Measured numeric values retain the same range and formula.

## 6b. Operator-surface quality

The neighboring empty `byVerdict` map makes the reason for null visible in the
same summary. No ideal-looking value is fabricated.

## 7. Multi-machine posture

Unchanged. Plain scope still summarizes the local ledger and pool collection
still follows its existing aggregation path.

## 8. Rollback cost

Pure code rollback: restore the numeric fallback. No ledger data or schema
migration is involved.

## Conclusion

Clear to ship as a small read-surface truthfulness correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no lifecycle, action,
authority, sentinel, guard, or gate behavior changes.

## Evidence pointers

- `tests/unit/BenchmarkDivergenceAnalyzer.test.ts`
- Twenty-four focused tests pass.
- Mutation proof: restoring the zero fallback produces one direct failure.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
