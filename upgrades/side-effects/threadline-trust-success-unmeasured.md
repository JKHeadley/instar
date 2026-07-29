# Side-Effects Review — Threadline trust success unmeasured state

**Version / slug:** `threadline-trust-success-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`AgentTrustManager.getInteractionStats()` now returns a null `successRate` when
the profile has no successful or failed interactions. OpenClaw status renders
that state as “success rate unknown.”

## Decision-point inventory

- Interaction-stat evidence sufficiency — modified — a rate requires at least
  one completed interaction.
- Trust levels and permission evaluation — passed through unchanged.
- Safety-only auto-downgrade — passed through unchanged.

## 1. Over-block

No operation is blocked. Permission checks use trust level and explicit
operation lists, not `successRate`.

## 2. Under-block

No permission or downgrade condition changes. A measured zero-percent rate
after one or more failures remains numeric zero.

## 3. Level-of-abstraction fit

`AgentTrustManager` owns both interaction counts and the denominator, so it owns
the nullable rate. OpenClaw owns the plain-language rendering. The HTTP route
passes the field through.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the changed field is read-only observability.

The authority-bearing trust and permission methods do not consume this rate.

## 4b. Judgment-point check

No heuristic is added. Null applies only to an empty mathematical denominator.

## 5. Interactions

- **Shadowing:** null replaces only the new-profile zero fallback.
- **Double-fire:** no events or notices are emitted.
- **Races:** persistence and counter updates are unchanged.
- **Feedback loops:** trust decisions do not read the rate.

## 6. External surfaces

The Threadline trust stats route can now return `successRate: null` for a known
profile with no interactions. OpenClaw status says “success rate unknown.”
Measured rates retain the same zero-to-one scale.

## 6b. Operator-surface quality

The status includes “0 successful, 0 failed” beside the unknown label, so the
reason is visible without inference.

## 7. Multi-machine posture

Unchanged. Trust profiles and their interaction history retain the existing
machine-local/replication behavior.

## 8. Rollback cost

Pure code rollback. No profile schema or stored history changes.

## Conclusion

Clear to ship as a bounded observability correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; permission, trust,
authority, action, and lifecycle behavior are unchanged.

## Evidence pointers

- `tests/unit/threadline/AgentTrustManager.test.ts`
- `tests/unit/threadline/OpenClawBridge.test.ts`
- 286 focused unit, integration, and end-to-end tests pass.
- Mutation proof: restoring the zero fallback produces two direct failures.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
