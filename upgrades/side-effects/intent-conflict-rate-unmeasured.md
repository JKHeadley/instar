# Side-Effects Review — Intent conflict rate unmeasured state

**Version / slug:** `intent-conflict-rate-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Intent-drift windows now use null conflict rates when they have no decisions.
Conflict-spike detection requires both windows to have measured rates.

## Decision-point inventory

- Conflict-rate evidence sufficiency — modified — a rate requires a decision.
- Conflict-spike signal — preserved — comparisons require two measured rates.
- Confidence, principle, volume, and alignment signals — passed through
  unchanged.

## 1. Over-block

No action is blocked. The detector emits advisory signals and the change
suppresses only a comparison against an empty window.

## 2. Under-block

Real zero-conflict windows remain numeric zero. A current measured nonzero rate
after a previous measured zero still emits the existing spike signal.

## 3. Level-of-abstraction fit

`IntentDriftDetector` owns window construction and signal comparison, so it can
carry evidence sufficiency through both producer and consumer. The CLI owns
formatting.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — conflict spikes are advisory signals, not blocking authority.

The change prevents a fabricated absence value from participating in signal
generation.

## 4b. Judgment-point check

No thresholds or severity judgments change. Only denominator sufficiency is
added.

## 5. Interactions

- **Shadowing:** null replaces only empty-window zeros.
- **Double-fire:** previous-only windows are explicitly tested not to emit a
  conflict spike.
- **Races:** journal reads and time-window selection are unchanged.
- **Feedback loops:** no action consumes the signal automatically.

## 6. External surfaces

Intent-drift analysis can now return `conflictRate: null` for an empty current
window. Measured values retain the same zero-to-one scale.

## 6b. Operator-surface quality

`decisionCount: 0` appears beside the null rate, and CLI formatting supports
“n/a.”

## 7. Multi-machine posture

Unchanged. The detector reads the same local journal and windows.

## 8. Rollback cost

Pure code rollback. No journal or schema changes.

## Conclusion

Clear to ship as a bounded signal-truthfulness correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; signal thresholds,
authority, action, persistence, and lifecycle behavior are unchanged.

## Evidence pointers

- `tests/unit/IntentDriftDetector.test.ts`
- Twenty focused tests pass.
- Mutation proof: restoring the zero fallback produces two direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
