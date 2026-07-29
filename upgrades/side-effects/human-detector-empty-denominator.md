# Side-Effects Review — Human-detector empty denominator

**Version / slug:** `human-detector-empty-denominator`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`HumanAsDetectorLog.getDriftCanary()` now returns `missRate: null` when
`sampled` is zero. Its sample and mismatch counters are unchanged, and measured
rates retain their existing calculation. The focused unit test pins both the
fresh-process unknown state and the measured one-in-three state.

## Decision-point inventory

No decision point is added or modified. This is a read-only observability value;
it neither classifies messages nor controls any action.

## 1. Over-block

No block/allow surface — over-block is not applicable.

## 2. Under-block

This bounded correction covers only the drift canary's miss-rate denominator.
Other derived-rate sites are being evaluated separately so each defect has an
isolated review and rollback surface. A consumer that ignores `sampled` and
cannot represent `null` must update its display rather than coercing unknown
back to zero; no repository consumer currently does so.

## 3. Level-of-abstraction fit

The correction belongs at the rate producer. Every caller then receives the
same honest distinction between no evidence and measured zero, while the
existing adjacent `sampled` field remains the denominator. Fixing a display
would leave other consumers exposed.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The canary is an observability signal. Changing its empty value does not give it
authority or change how any message is handled.

## 4b. Judgment-point check

No static heuristic or competing-signals judgment point is added. A zero
denominator is structurally unmeasurable.

## 5. Interactions

- **Shadowing:** no parallel rate producer or display is bypassed.
- **Double-fire:** no action fires from this return value.
- **Races:** the existing in-memory counters and update order are unchanged.
- **Feedback loops:** the value is read-only and is not fed back into sampling
  or classification.

## 6. External surfaces

Code importing the public method now sees `number | null` rather than a numeric
zero before the first sample. There are no current repository consumers beyond
the unit tests. No external service, message, persistent record, timer, or
operator action changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** The canary measures samples observed by one running
process and stores only in-memory counters. This change adds no notices, durable
state, topic-bound data, or URLs, so it cannot strand data or duplicate
delivery across machines.

## 8. Rollback cost

Pure code rollback: restore the numeric fallback and the previous return type.
No data migration or agent-state repair is required.

## Conclusion

Clear to ship as a small corrective PR. The producer now states that no sample
means no measurement, while measured zero remains available after real samples.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; the change is a read-only
metric correction and does not touch a gate, sentinel, watchdog, messaging, or
session-lifecycle authority.

## Evidence pointers

- `tests/unit/HumanAsDetectorLog-correction-learning.test.ts`
- 11 focused tests pass.
- Mutation proof: restoring the numeric-zero fallback makes the fresh-process
  assertion fail with `expected 0 to be null`; restoring the correction passes.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
