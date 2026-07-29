# Side-Effects Review — Semantic confidence unmeasured state

**Version / slug:** `semantic-confidence-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Semantic-memory store statistics and confidence-decay reports now use null
confidence values when no active entity supplies a denominator. CLI output
renders those states as “n/a.”

## Decision-point inventory

- Aggregate-confidence evidence sufficiency — modified — confidence summaries
  require at least one active entity.
- Decay and hard expiry — passed through unchanged.
- Search, recall, and persistence — passed through unchanged.

## 1. Over-block

No operation is blocked. The changed values are statistics and command output.

## 2. Under-block

Expiry and decay still run exactly as before. An all-expired report retains its
processed and expired counts while declining to fabricate confidence values.

## 3. Level-of-abstraction fit

`SemanticMemory` owns both the SQL aggregate and active-entity count, so it owns
the nullable values. The semantic command owns plain-language formatting.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the changed values are read-only observability.

No admission, expiry, search, or retention decision consumes these aggregates.

## 4b. Judgment-point check

No heuristic is added. Null applies only when the aggregate has no active row.

## 5. Interactions

- **Shadowing:** null replaces only empty/all-expired zero defaults.
- **Double-fire:** no events or notices are emitted.
- **Races:** transactions and SQL reads are unchanged.
- **Feedback loops:** the aggregates do not control confidence updates.

## 6. External surfaces

`GET /semantic/stats` can now return `avgConfidence: null` for an empty store.
`semantic stats` prints “Avg conf: n/a.” An all-expired decay run prints
“Confidence: n/a (no active entities).” Measured numeric values are unchanged.

## 6b. Operator-surface quality

Entity and expiry counts remain beside the nullable values, so the absence is
explainable from the same output.

## 7. Multi-machine posture

Unchanged. Semantic-memory database ownership and synchronization behavior are
not modified.

## 8. Rollback cost

Pure code rollback. No database schema or stored entity changes.

## Conclusion

Clear to ship as a bounded observability correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no action, authority, gate,
sentinel, lifecycle, or persistence behavior changes.

## Evidence pointers

- `tests/unit/semantic-memory.test.ts`
- Fifty-one focused tests pass.
- Mutation proof: restoring the zero fallbacks produces three direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
