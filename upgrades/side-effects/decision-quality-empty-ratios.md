# Side-Effects Review — Decision-quality empty ratios

**Version / slug:** `decision-quality-empty-ratios`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Three per-point decision-quality ratios return `null` instead of zero when
their individual denominators are empty.

## Decision-point inventory

- HTTP response assembly — modified — zero denominators are explicit.
- Insufficient-evidence decision — unchanged.
- Pool field allowlist — unchanged; nullable values pass through the same keys.

## 1. Over-block

No gate or action reads these ratios in this change. The populated route retains
numeric zero when the denominator exists.

## 2. Under-block

Every zero-denominator branch in this per-point response cluster is covered:
decisions, outcome rows, and settled grades.

## 3. Level-of-abstraction fit

The response assembler owns both the counts and the derived ratios. It can
express absence without changing the ledger.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — this is an observability response only.

No authority, threshold, or enforcement path changes.

## 4b. Judgment-point check

No heuristic judgment. A ratio without its denominator is mechanically
unmeasurable.

## 5. Interactions

- **Shadowing:** `insufficientEvidence` remains true on empty rows.
- **Double-fire:** no events or actions.
- **Races:** read-only assembly over the existing ledger snapshot.
- **Feedback loops:** pool responses preserve the same allowed fields.

## 6. External surfaces

API consumers see `null` rather than `0` for the three empty ratios. All
denominator counts remain present.

## 6b. Operator-surface quality

The response can no longer contradict itself by pairing
`insufficientEvidence: true` with ideal-looking zero ratios.

## 7. Multi-machine posture

Local and peer rows use the same field allowlist. No cross-machine state
changes.

## 8. Rollback cost

Pure response-shape rollback. No persistence or migration.

## Conclusion

Clear to ship as a bounded observability correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no guard, gate, lifecycle,
or authority behavior changes.

## Evidence pointers

- `tests/integration/decision-quality-routes.test.ts`
- Mutation proof: restoring the three zeros fails the empty-point and
  unknown-only assertions.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
