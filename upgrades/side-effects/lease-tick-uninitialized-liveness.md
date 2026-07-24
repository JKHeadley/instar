# Side-Effects Review — Lease-tick uninitialized liveness

**Version / slug:** `lease-tick-uninitialized-liveness`  
**Date:** `2026-07-19`  
**Author:** `Instar-codey`  
**Second-pass reviewer:** `migration_guard_review (independent)`

## Summary of the change

This change closes a boot-time false-recovery class in `MultiMachineCoordinator.runTickWatchdog()`. The watchdog previously treated `lastTickRunMonoMs === 0` (no first sample) as stale, re-armed a healthy timer, and emitted `MultiMachine.leaseTick` degradation roughly one minute after ordinary boot. `src/core/cadenceLiveness.ts` introduces an explicit `uninitialized | healthy | stale` classifier. A separate `heartbeatMonitorArmedMonoMs` supplies positive first-fire evidence: ordinary startup is healthy, while an armed interval that never produces callback #1 becomes stale after the full ceiling. P20 in both standards surfaces is amended with the cadence-specific unknown-state rule. Unit, integration, and E2E lifecycle tests prove boot silence, lost-first-fire recovery, and genuine-stale recovery.

## CLASS review — before the instance fix

- **Missing standard application:** P20 already said absence is unknown, but did not state the common cadence-watermark case. The missing operational rule was: a zero/absent/invalid/not-yet-observed timestamp is `uninitialized`, never `stale`; only the age of a real prior observation can authorize recovery or notification.
- **Process gap:** the original tests covered an ancient positive timestamp and a fresh positive timestamp, but omitted zero/uninitialized and never ran the actual first watchdog timer after boot. The approved spec explicitly claimed a boot reset could not false-trigger, yet no lifecycle test exercised that claim.
- **Class fix:** the discriminated-union classifier makes the third state structural and reusable; positive timer-arm evidence prevents unknown from becoming a permanent blind spot; P20 registers the rule; three tiers pin the classifier boundary, coordinator wiring, and timer lifecycle.
- **Instance fix:** `runTickWatchdog()` consumes the newest positive baseline (last tick, otherwise timer arm) and acts only when it classifies stale.

## Decision-point inventory

- `MultiMachineCoordinator.runTickWatchdog` — **modify** — the self-heal actuator may re-arm and notify only after a real prior tick becomes stale.
- `classifyCadenceLiveness` — **add** — deterministic structural state classification; it has no authority by itself.

## 1. Over-block

No user input is blocked. A watchdog callback before the first tick sample stays quiet while the timer-arm baseline is within the normal window. Once the arm baseline or a real tick crosses the stale ceiling, recovery behavior is unchanged.

## 2. Under-block

The change does not detect a timer that failed before the successful `setInterval` assignment/arm stamp; startup exceptions are handled by the owning server lifecycle. A timer lost after successful arm but before callback #1 is now detected and recovered. True event-loop stalls remain delegated to the out-of-process fleet watchdog as the approved spec requires.

## 3. Level-of-abstraction fit

The classifier is a low-level deterministic detector over an enumerable timing domain. It returns structured state and never acts. `runTickWatchdog` remains the existing constrained authority for timer re-arm. The helper belongs below the coordinator because the uninitialized/healthy/stale distinction is common to cadence monitors, while lease-specific recovery stays in the coordinator.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The domain is an enumerable hard invariant rather than a semantic judgment: without a prior positive observation, elapsed staleness cannot be measured. The classifier carries no actuation. The existing watchdog authority consumes `stale` and retains its ceiling, re-arm rate, breaker, and dedupe constraints.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals decision point. The three states follow directly from whether a valid observation exists and whether its measured monotonic age crosses the already-approved configured ceiling.

## 5. Interactions

- **Shadowing:** no check is shadowed. The classifier replaces the watchdog’s incomplete two-state inline condition.
- **Double-fire:** boot callbacks now remove one false fire; genuine stale callbacks retain the existing per-episode dedupe.
- **Races:** no new shared mutable state. The helper is pure. Existing guard-reset ceilings still protect live in-flight ticks.
- **Feedback loops:** fewer false degradation records enter the feedback pipeline. Genuine recovery records are unchanged.

## 6. External surfaces

Other agents and users stop seeing false `MultiMachine.leaseTick` degradation events after routine boot. There are no new operator actions, API fields, URLs, external calls, or persistent formats. Timing remains machine-dependent, but the decision uses that machine’s monotonic clock only.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design:** cadence timestamps describe one process’s local timer health and use its local monotonic clock. The consequence remains the existing local timer re-arm; lease authority itself stays cross-machine and fenced. The change emits no new user-facing notice (it removes false local notices), holds no durable state, and generates no URLs. Existing degradation routing continues to provide one-voice behavior.

## 8. Rollback cost

- **Hot-fix release:** revert the helper use and standards/test additions.
- **Data migration:** none.
- **Agent state repair:** none; all state is process-local and ephemeral.
- **User visibility:** rollback would reintroduce false boot degradation messages but would not alter lease ownership.

## Conclusion

The design closes the root class rather than suppressing the symptom: unknown cadence state is represented explicitly, registered in P20, and tested through the real boot timer. Genuine stale recovery remains live. The change is ready for independent watchdog review before commit.

## Second-pass review (required)

**Reviewer:** `migration_guard_review`  
**Independent read of the artifact:** **concur**

The first review blocked the initial design because returning forever on a zero first-tick watermark would blind the watchdog if the main interval disappeared before callback #1. The corrected design adds a distinct positive timer-arm watermark: normal startup remains silent inside the ceiling, and a lost pre-first-fire interval recovers/reports exactly once after that arm evidence becomes stale. Re-review verified the lifecycle test, unchanged lease authority/fencing, 29/29 targeted checks, and green TypeScript; no concerns remain.

## Evidence pointers

- `tests/unit/cadence-liveness.test.ts`
- `tests/unit/MultiMachineCoordinator-tickSelfHeal.test.ts`
- `tests/integration/coordinator-server.test.ts`
- `tests/e2e/lease-tick-watchdog-boot-lifecycle.test.ts`
- Live survivor evidence: eight identical `MultiMachine.leaseTick` degradations on 2026-07-19, including two only 8m26s apart; code reproduction proved the first watchdog callback reports with `lastTickRunMonoMs=0`.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/e2e/lease-tick-watchdog-boot-lifecycle.test.ts, howCaught: the real self-triggered watchdog timer is driven through its first boot callback and must settle at zero recovery/notification actions during healthy startup; a deliberately lost pre-first-fire interval then produces exactly one recovery/report after the positive arm baseline becomes stale, preserving both convergence and liveness }`.
