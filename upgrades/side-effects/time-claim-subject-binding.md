# Side-Effects Review — TIME_CLAIM subject binding

**Version / slug:** `time-claim-subject-binding`  
**Date:** 2026-07-24  
**Author:** Instar-codey  
**Second-pass reviewer:** not required

## Summary of the change

The pure TIME_CLAIM extractor now drops anchored durations whose local clause names a competing non-session subject. The standards registry gains the class-wide subject-binding rule, and the regression suite pins both decision sides.

## Decision-point inventory

- `extractTimeClaims` — modified signal classification — decides whether a duration is eligible for comparison with caller-supplied session clocks.
- Advisory disposition is unchanged. TIME_CLAIM remains the existing inform-and-ack surface.

## 1. Over-block

No new messages are held. The change only removes false-positive candidates. A clause containing both a session noun and a closer competing duration noun is treated as non-session; tests pin the intended examples.

## 2. Under-block

An unusual competing subject not represented structurally may still be interpreted as the unqualified session default. This is bounded by the existing generous contradiction tolerance and audited acknowledgment path. The new standard requires future observed subject classes to extend the paired boundary table.

## 3. Level-of-abstraction fit

Subject binding belongs beside extraction, before numerical comparison. The caller already provides typed session clocks; the extractor determines whether the candidate refers to that typed subject. No second advisory or model pipeline is introduced.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This deterministic layer only drops obvious competing subjects toward pass-through. It does not create a new positive trigger or new authority. The original advisory and audited override remain unchanged.

## 4b. Judgment-point check

The implementation does not add a competing-signals authority. It narrows a pre-existing structural detector using local subject evidence and fails toward delivery when a competing subject is present.

## 5. Interactions

The numeric tolerance, clock selection, multi-clock leniency, route wiring, relay acknowledgment, and audit behavior are unchanged. The change shares no mutable state and introduces no races, retries, or feedback loops.

## 6. External surfaces

Correct messages describing non-session durations stop receiving TIME_CLAIM advisories. Actual session-clock contradictions retain the same guidance and override. There is no persistent-state or external API change and no operator action is added.

## 6b. Operator-surface quality

No dashboard or form is changed. The existing advisory becomes more selective and retains plain-language correction guidance.

## 7. Multi-machine posture

**Machine-local by design:** each outbound send is checked against the active clock supplied by the sending machine/topic route. No state is stored, no URL is generated, and no user-facing notice is emitted independently of the send.

## 8. Rollback cost

Revert the extractor and standards/test additions, then ship a patch. There is no data migration or state repair.

## Conclusion

The review closes the observed class without weakening real session-clock verification. It replaces the knowingly accepted “CI queue” false positive with a standards-backed, both-sides subject boundary. Clear to ship.

## Second-pass review

Not required: this does not change messaging authority or delivery mechanics; it only narrows a pure signal toward pass-through.

## Evidence pointers

`tests/unit/time-claim.test.ts`, `tests/unit/outbound-advisory*.test.ts`, and `tests/e2e/outbound-advisory-alive.test.ts`: 71 passed.

## Class-Closure Declaration

No agent-authored prompt, hook, config, skill, or standards-text defect is being repaired; the defect is product classifier logic. Not applicable.
