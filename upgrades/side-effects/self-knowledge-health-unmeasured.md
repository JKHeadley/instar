# Side-Effects Review — Self-knowledge health unmeasured state

**Version / slug:** `self-knowledge-health-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`CoverageAuditor.healthSummary()` now makes its three trace-derived rates
nullable when no valid samples exist, and makes cache hit rate nullable when a
search performed no cache operation. Machine diagnostics render those states
as “no search samples” or “cache hit n/a.”

## Decision-point inventory

- Trace evidence sufficiency — modified — rates require their actual sample
  denominators.
- Tree validation and health status — passed through unchanged.

## 1. Over-block

No action is blocked. Existing consumers receive null instead of zero only when
the underlying trace or cache-operation denominator is empty.

## 2. Under-block

The trace reader still skips corrupt individual lines and summarizes remaining
valid entries. It does not expose a corrupt-line count, so partial trace
corruption remains outside these rate fields.

## 3. Level-of-abstraction fit

Nullability belongs in `CoverageAuditor`, which owns trace parsing and knows the
denominators. HTTP passes the fields through, while the machine command owns
plain-language formatting of the nullable result.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Self-knowledge health is read-only observability. The machine command's status
continues to depend on tree validation errors and warnings, not these rates.

## 4b. Judgment-point check

No heuristic is added. The change applies only mathematical denominator
requirements and explicit absence rendering.

## 5. Interactions

- **Shadowing:** null replaces the prior all-zero default; measured paths remain
  unchanged.
- **Double-fire:** no events or notices are emitted.
- **Races:** trace file reading remains synchronous and unchanged.
- **Feedback loops:** the metrics do not control search or cache behavior.

## 6. External surfaces

`GET /self-knowledge/health` can now return null for `cacheHitRate`,
`avgLatencyMs`, and `errorRate`. Machine diagnostics add “no search samples” and
“cache hit n/a.” Measured numeric values retain the same units and formulas.

## 6b. Operator-surface quality

The diagnostic names why a percentage is absent and keeps the existing search
count in the HTTP response, so null is explainable rather than ambiguous.

## 7. Multi-machine posture

**Machine-local by design.** Search traces and cache behavior belong to the host
that served the self-knowledge query. No replicated state or URL changes.

## 8. Rollback cost

Pure code rollback: restore the numeric defaults and CLI formatting. No trace or
tree data requires migration.

## Conclusion

Clear to ship as a small corrective PR. It changes only read-surface truthfulness.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no lifecycle, action,
authority, sentinel, guard, or gate behavior changes.

## Evidence pointers

- `tests/unit/CoverageAudit.test.ts`
- Eleven focused tests pass.
- Mutation proof: restoring both zero fallbacks produces two direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
