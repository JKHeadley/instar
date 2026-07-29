# Side-Effects Review — Self-knowledge empty coverage

**Version / slug:** `self-knowledge-empty-coverage`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Zero-node self-knowledge trees carry nullable coverage through validation,
audit, HTTP, and machine-check output.

## Decision-point inventory

- Tree validation — modified — zero nodes means unmeasured.
- Coverage audit — modified — nullable score, explicit zero counts.
- Health/API/CLI presentation — modified — null or `coverage n/a`.

## 1. Over-block

No action or gate consumes the score. Trees with nodes keep numeric coverage.

## 2. Under-block

Both the primary validation result and the audit wrapper preserve the empty
state. CLI formatting does not round null into zero.

## 3. Level-of-abstraction fit

Validation owns the denominator. Consumers propagate or render the resulting
state without recalculating it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — these are observability surfaces only.

No validation validity, routing, or enforcement behavior changes.

## 4b. Judgment-point check

No heuristic judgment. Zero-node division is mechanically unmeasurable.

## 5. Interactions

- **Shadowing:** node and valid-node counts remain visible.
- **Double-fire:** no events.
- **Races:** synchronous validation over the loaded configuration.
- **Feedback loops:** coverage with a positive denominator is unchanged.

## 6. External surfaces

The health API returns `coverageScore: null`; the machine check prints
`coverage n/a` for an empty tree.

## 6b. Operator-surface quality

The output no longer combines `0 nodes` with a claimed `0% coverage`
measurement.

## 7. Multi-machine posture

Each machine validates its own tree with the same response contract.

## 8. Rollback cost

Pure type, calculation, and presentation rollback. No persistence.

## Conclusion

Clear to ship as a bounded observability correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no gate, guard, authority,
or lifecycle behavior changes.

## Evidence pointers

- `tests/unit/SelfKnowledgeTree.test.ts`
- `tests/unit/CoverageAudit.test.ts`
- Mutation proof: restoring zero on an empty tree fails validation.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
