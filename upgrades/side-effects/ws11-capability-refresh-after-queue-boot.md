# Side-Effects Review — WS1.1 capability refresh after queue boot

**Version / slug:** `ws11-capability-refresh-after-queue-boot`
**Date:** `2026-07-17`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `pending`

## Summary of the change

After `QueueDrainLoop` is successfully constructed in `src/commands/server.ts`, the existing `refreshPool()` heartbeat writer is invoked immediately. This republishes the already-existing live capability fields from their late-bound runtime handles. The change touches the cross-machine forwarding readiness decision consumed by `SessionRouter.ownerSupportsForward`; it does not alter ownership, queue custody, placement, or forwarding policy.

## Decision-point inventory

- `SessionRouter.ownerSupportsForward` input — pass-through — the change makes its existing authenticated heartbeat signal current immediately after queue startup.
- Queue construction invariant — pass-through — refresh occurs only after successful construction and does not run on the queue-dark or construction-failed branches.

## 1. Over-block

No new block rule is added. A peer can now begin forwarding sooner after boot. The existing capability contract is handle-based (`!!_inboundQueue`): successful construction advertises receive capability, and this change advances that same signal without claiming runtime-health withdrawal. A later internal queue degradation does not currently clear the handle or withdraw the advert; that pre-existing limitation remains visible in the under-block analysis.

## 2. Under-block

This does not make forwarding safe when the durable queue is deliberately disabled, when the owner is unreachable, or when the owner advert is stale for other reasons. It also does not add runtime-health withdrawal after successful queue construction: if the queue later degrades internally while its handle remains assigned, peers continue to see the existing handle-based capability. Those paths remain governed by the existing queue, ownership, SpawnAdmission, degradation reporting, and owner-dark policies.

## 3. Level-of-abstraction fit

The fix is at the capability producer, not in `SessionRouter`: the router already consumes the correct authenticated capability. Re-deriving queue state remotely or weakening the conservative capability gate would be the wrong layer. `refreshPool()` is the single existing heartbeat authority and is reused unchanged.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The change refreshes an objective runtime capability signal. It neither adds a new judgment rule nor grants a low-context detector independent blocking authority. The existing deterministic gate is an enumerable compatibility invariant: do not forward into a peer that has not advertised durable receive.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Queue construction is an objective runtime invariant, and the existing router policy remains unchanged.

## 5. Interactions

- **Shadowing:** no policy is shadowed; the refresh feeds the same `MachinePoolRegistry.recordHeartbeat` path as scheduled beats.
- **Double-fire:** a scheduled beat may occur adjacent to this refresh. `recordHeartbeat` is idempotent for capability state, so the duplicate observation is harmless.
- **Races:** refresh runs synchronously after `_inboundQueue` assignment; it cannot advertise true before construction succeeds.
- **Feedback loops:** peer pullers consume the advert but do not mutate the local queue handle.

## 6. External surfaces

Other machines see the capability become true immediately rather than on a later heartbeat. No response schema, operator action, URL, persistent payload, or external-service API changes. The only behavioral consequence is that already-authorized cross-machine forwarding can start promptly.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** — the queue's live receive capability is published through the authenticated machine-capacity heartbeat and consumed from `MachinePoolRegistry` by peers. This change explicitly closes a cross-machine boot-order gap. It emits no user-facing notice, holds no new durable state, and generates no URL.

## 8. Rollback cost

Pure code change: revert the refresh call and ship a patch. No data migration or agent-state repair is required. Rollback restores the prior bounded stale-false boot window.

## Conclusion

The change reuses the existing capability authority and changes only refresh timing. It closes the live-observed stale-false boot window without weakening the conservative version-skew gate or changing custody semantics. Clear for an independent high-risk second pass.

## Second-pass review (if required)

**Reviewer:** Poincare (`continuation_impl_review`)
**Independent read of the artifact:** concur after correction — the first pass caught and removed an inaccurate claim that a later heartbeat withdraws capability after internal queue degradation; implementation timing and authority boundaries otherwise concurred.

## Evidence pointers

- `tests/unit/ws11-dispatch-to-owner-wiring.test.ts`
- Live topic-3462 reproduction in topic 458, 2026-07-17 12:53 PDT.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
