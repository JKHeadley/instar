# Side-Effects Review — Red-team empty derivation ratio

**Version / slug:** `redteam-empty-derivation-ratio`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`BoundaryMap.derivationRatio` is nullable when a probe result set contains no
refusals.

## Decision-point inventory

- Boundary-map assembly — modified — no denominator means null.
- Scenario pass/fail and crack-depth decisions — unchanged.
- Consumers — none in production; this is a public result contract correction.

## 1. Over-block

No gate or action consumes the field. Refusal-bearing runs retain numeric
ratios, including measured zero.

## 2. Under-block

The test distinguishes no refusals from ungrounded refusals.

## 3. Level-of-abstraction fit

The boundary-map assembler owns both refusal counts and the derived field.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — a report field only.

## 4b. Judgment-point check

No heuristic judgment. The denominator either exists or does not.

## 5. Interactions

- **Shadowing:** per-probe outcomes remain visible.
- **Double-fire:** no events.
- **Races:** pure function.
- **Feedback loops:** no production consumer.

## 6. External surfaces

Library consumers see `null` for an unmeasured derivation ratio.

## 6b. Operator-surface quality

No-refusal and zero-grounded-refusal runs are no longer byte-identical.

## 7. Multi-machine posture

Pure over provided results; machine-independent.

## 8. Rollback cost

Type and pure-function rollback only.

## Conclusion

Clear to ship as low-urgency correctness hygiene.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no guard, gate, lifecycle,
or authority behavior changes.

## Evidence pointers

- `tests/unit/redteam-scenario-pack.test.ts`
- Mutation proof: restoring zero for no refusals fails the test.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
