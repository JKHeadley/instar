# Side-Effects Review — Cross-Machine Seamlessness: consented lease acquire (planned handoff)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3e (converged, approved)

The lease primitive a PLANNED handoff needs: the incoming machine takes the lease
while the outgoing is still alive, which the liveness-gated `acquireIfEligible()`
correctly refuses. Added as an ADDITIVE consent path — the split-brain-critical
`canAcquire()` gate (hardware-verified for G1) is deliberately left untouched.

## What changed
- `src/core/LeaseCoordinator.ts` — NEW `acquireOnConsent(yieldFromMachineId)`.
  Bypasses the liveness `canAcquire()` gate (because the holder explicitly consented
  via a verified yield), CAS-advances to epoch+1, broadcasts, emits the new epoch.
  **Security guard:** if there is a current holder and it is NOT the yielding machine,
  the acquire is REFUSED — a yield from any non-holder cannot trigger a takeover.
  Already-ours → true (idempotent); empty lease → acquire.
- `src/core/MultiMachineCoordinator.ts` — NEW `acquireLeaseOnConsent(yieldFromMachineId)`:
  the onYield entry point — delegates to the guarded consent path, then reconciles
  role → awake on success.

## Over-block / under-block
- The guard is the security boundary: only the CURRENT holder's yield grants the
  takeover. Combined with the route's machineAuth (the yield came from an
  authenticated machine), a forged or misdirected yield is doubly defeated.
- If the CAS is lost (someone already advanced), the consent acquire adopts the
  observed epoch and stands down — no double-advance, no split-brain.
- The existing `acquireIfEligible()` / `canAcquire()` / `renew()` paths are byte-for-byte
  UNCHANGED, so the hardware-verified G1 split-brain guarantee is preserved exactly. This
  is purely additive surface reachable only from the handoff yield handler.

## Signal vs authority
- This IS an authority mutation (it advances the lease epoch) — and it is correctly
  gated: reachable only from the authenticated /api/handoff/yield handler, and only
  when the yielding machine is the observed holder. The decision to yield (verified
  ack + validation) lives upstream in HandoffSentinel.

## Interactions
- Consumed (next integrating commit) by the /api/handoff/yield route's onYield handler:
  `coordinator.acquireLeaseOnConsent(fromMachineId)`. The outgoing machine's HandoffSentinel
  sends the yield only after a verified ack + passing validation, so by the time consent
  reaches the incoming, the outgoing has committed to standing down.
- Mirrors the success path of acquireIfEligible (effectiveView → buildAcquisition → casWrite
  → broadcast → emitEpoch), so behavior is consistent with the proven acquisition flow.

## Rollback cost
- Minimal — two additive methods, no change to existing paths. Reverting removes them.

## Tests
- `tests/unit/LeaseCoordinator.test.ts` (+4, 12 total): consent takes a LIVE peer-held
  lease (the bypass) while the normal path refuses it; **SECURITY — a yield from a
  non-holder is refused (no takeover)**; idempotent when already held; acquires from empty.
  tsc clean.
