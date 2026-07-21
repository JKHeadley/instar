# Side-Effects Review — SelfHealGate

**Version / slug:** `self-heal-gate`
**Date:** 2026-07-21
**Author:** Instar-codey
**Second-pass reviewer:** self_heal_sec_adv

## Summary of the change

Adds a bounded, durable SelfHealGate over the existing self-action governor and failure latch, then wires feedback-factory generated-default repair as its first real consumer. It changes local boot-time repair admission, durable episode state, attention delivery, filesystem replacement, and restart verification.

## Decision-point inventory

- `SelfHealGate.attempt` — add — refuses ambiguous severity, stale ownership, exceeded bounds, or invalid durable state.
- Self-action governor admission — pass-through — remains the sole rate/concurrency authority; observe mode remains non-blocking.
- Generated-default inspection — modify — classifies structural filesystem evidence before remediation.

## 1. Over-block

The gate can refuse a legitimate repair when the 256-row durable store is saturated, ownership cannot be proven, SQLite is unavailable, or evidence is structurally ambiguous. These are intentional fail-safe outcomes because mutation without durable bounds or ownership would be unsafe. Healthy files and fleet-dark agents are unchanged.

## 2. Under-block

Synchronous kernel/filesystem stalls cannot be hard-timed-out in process. V1 also retains recovered rows rather than reclaiming capacity, so long-lived machines may reach the cap and require attention instead of repairing. Neither path permits unbounded mutation.

## 3. Level-of-abstraction fit

The gate is a thin safety facade at the controller boundary. It reuses the governor for admission and the latch for episode timing rather than creating competing authorities. Typed inspection is a detector; the gate combines that evidence with durable episode, ownership, and policy state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is deterministic hard-invariant and irreversible-action safety policy, not semantic judgment over user content.

Structural validators produce typed evidence. The deterministic authority operates only over enumerable safety invariants: valid severity, exclusive ownership, bounded attempts/time/flaps, durable state, and consume-once admission.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals judgment point. Every deny condition is an enumerated safety floor in the converged spec; the existing governor retains admission authority above those floors.

## 5. Interactions

- **Shadowing:** fleet-dark and healthy paths exit before remediation; governor policy still runs for actionable episodes.
- **Double-fire:** CAS attempt claims and stable notice/restart ids deduplicate concurrent boots and retries.
- **Races:** owner fence is checked at admission, after token consumption, and inside the SQLite attempt-claim transaction. Notice state advances only after awaited durable enqueue.
- **Feedback loops:** restart verification requires a different boot incarnation and cannot be closed by same-boot `recordHealthy`.
- **Shutdown:** the long-lived SQLite handle registers with the shared close-on-exit registry and unregisters before explicit close.

## 6. External surfaces

The change adds machine-local `state/self-heal-gate.db`, may create the existing generated-default file, may write the established restart request, and may enqueue a HIGH/URGENT attention item. It adds no URLs or new operator actions; existing attention and restart surfaces remain phone-completable.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator renderer or form is changed — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** the repaired file, lease fence, boot incarnation, SQLite episode state, and restart request describe one machine. Only the canonical hardware-bound owner may act. Notices use the existing one-voice attention path. Durable state does not follow topic transfer because it protects machine-local filesystem mutation. No URLs are generated.

## 8. Rollback cost

- **Hot-fix release:** revert and ship the next patch.
- **Data migration:** optional removal of `state/self-heal-gate.db` while no process is running; leaving it is harmless.
- **Agent state repair:** generated defaults use the existing valid schema; restart requests use the existing lifecycle.
- **User visibility:** rollback removes automatic repair and returns to warning/manual handling.

## Conclusion

The review found and fixed premature notice acknowledgment, a lease-change race at attempt claim, missing queued-continuation terminal checks, state-failure notice fallback, and same-boot restart closure. The remaining limitations fail safe without mutation and are explicit in the spec and release notes.

## Second-pass review (if required)

**Reviewer:** self_heal_sec_adv
**Independent read of the artifact:** concur — no remaining release blocker after direct verification of durable notice enqueue, transactional fence claim, queued latency/bound checks, closed audit reasons, state-failure fallback notice, and restart handshake bounds. The reviewer noted only that direct admissions currently advance the diagnostic latch twice; elapsed-time and side-effect bounds are unaffected.

## Evidence pointers

- `tests/unit/SelfHealGate.test.ts`
- `tests/e2e/self-heal-gate-alive.test.ts`
- `tests/unit/self-action-convergence.test.ts`
- `docs/specs/reports/self-heal-gate-convergence.md`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registry ratchet requires the controller to declare a control-loop edge, finite attempt/time/flap bounds, and a restart-surviving settling brake; an unbounded repair loop would fail the test. }`
