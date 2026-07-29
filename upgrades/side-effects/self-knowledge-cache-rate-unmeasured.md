# Side-Effects Review — Self-knowledge cache rate unmeasured state

**Version / slug:** `self-knowledge-cache-rate-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`TreeTraversal.cacheStats()` now returns a null hit rate before any hit or miss,
and `SelfKnowledgeTree` returns null when a search cannot load a tree. A real
cache miss remains numeric zero.

## Decision-point inventory

- Cache-stat evidence sufficiency — modified — a rate requires a hit or miss.
- Traversal, source gathering, and cache invalidation — passed through
  unchanged.

## 1. Over-block

No operation is blocked. These values are returned by read surfaces.

## 2. Under-block

No error handling changes. A missing tree still returns the existing degraded
result and source error; only its unmeasured rate changes.

## 3. Level-of-abstraction fit

`TreeTraversal` owns the hit and miss counters and therefore owns denominator
sufficiency. `SelfKnowledgeTree` owns the pre-traversal failure result.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the changed values are read-only observability.

No search admission, cache policy, or validation decision reads the rate.

## 4b. Judgment-point check

No heuristic is added. Null applies only when both cache counters are zero.

## 5. Interactions

- **Shadowing:** null replaces only no-lookup zero fallbacks.
- **Double-fire:** no events or notices are emitted.
- **Races:** cache counters and map access are unchanged.
- **Feedback loops:** the rate does not control cache behavior.

## 6. External surfaces

Self-knowledge search results and validation cache stats can now return null for
their cache hit rate when no lookup occurred. Measured values retain the same
zero-to-one scale.

## 6b. Operator-surface quality

The response carries hit and miss counts beside cache stats, and degraded search
results retain their error, so null has an explicit reason.

## 7. Multi-machine posture

Unchanged. The traversal cache remains process-local.

## 8. Rollback cost

Pure code rollback. No cache or tree data migration is involved.

## Conclusion

Clear to ship as a bounded read-surface correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no action, authority, gate,
sentinel, lifecycle, or persistence behavior changes.

## Evidence pointers

- `tests/unit/TreeTraversal.test.ts`
- `tests/unit/SelfKnowledgeTree.test.ts`
- Twenty-seven focused tests pass.
- Mutation proof: restoring both zero fallbacks produces two direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
