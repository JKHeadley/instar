# Side-effects review: delivery reliability recovery hardening

1. Over-block: explicit `enabled:false` remains a supported operator opt-out; stale rows are withheld from redelivery, so only messages whose conversational context is no longer timely are held.
2. Under-block: this stopping point prevents destructive purge and preserves stale evidence, but the aggregate queue-health attention drain remains the next bounded implementation slice.
3. Level of abstraction: the sentinel remains the recovery signal/consumer; liveness pause is an actuation brake, not a detector; attention acceptance is durable before provider I/O.
4. Signal vs authority: queue age and orphan observations produce state/evidence. The only authority retained here is the existing resume queue and outbound tone gate.
5. Interactions: startup recovery, event kicks, and watchdogs remain idempotent; attention creation remains idempotent by item id, while the route timeout prevents provider latency from blocking HTTP acceptance.
6. External surfaces: `/attention` now returns promptly with an accepted OPEN item when Telegram is slow; stale relay rows are not silently deleted or redelivered late.
7. Multi-machine posture: relay state and attention persistence are machine-local by design, keyed by agent identity; liveness evidence is local to the owning machine and existing ownership/lease gates still prevent cross-machine actuation.
8. Rollback cost: revert the commit; no schema migration or destructive data operation is introduced, and retained rows remain available for a later incident drain.

Second-pass review: concur with the review. The pause gate is moved from classification to actuation, preserving dry-run evidence without weakening ownership, lease, or operator-stop checks.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `guard`
- enforcement: ratchet
- citation: `tests/unit/self-action-convergence.test.ts`
- how caught: queue watchdog, stale-age withholding, liveness debounce, and attention idempotency provide bounded convergence.
