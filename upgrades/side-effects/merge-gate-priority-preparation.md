# Side-Effects Review — Merge-gate priority through preparation

**Version / slug:** `merge-gate-priority-preparation`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** priority_review (independent Codex reviewer)

## Summary of the change

Local Verify keeps renewing its existing host-local full-suite priority claim while a local or peer child installs, builds, and lints. The child still acquires the actual suite slot through the existing semaphore. The coordinator releases its claim when the run finishes, is cancelled, or is held. The spec, ELI16 overview, scaffold, and update migration describe this behavior.

## Decision-point inventory

- `LocalVerifyService.pump()` — modified — a runnable in-flight verify retains the next-slot claim.
- `LocalVerifyService.cancelInFlight()` / `onExit()` — modified — cancellation or peer completion clears the claim.
- Host test-runner semaphore admission — passed through — its existing full-suite priority policy remains the authority.

---

## 1. Over-block

An ordinary full suite may wait while a verify child is still preparing, even if the slot is idle. That wait is intentional: repeated ordinary suites previously kept merge verification from starting. A stalled coordinator's claim expires in two minutes without the 30-second renewal tick; targeted tests use another lane. After the child acquires the slot, the service observes that holder on its next tick and clears its claim, so a host configured for two full suites can use the spare slot. The extra wait is bounded by the 30-second tick under normal operation.

## 2. Under-block

A full suite from a checkout that predates the priority-aware limiter can still enter. A failed claim write leaves the existing fail-open behavior and emits `suite-priority-error`. A just-started ad-hoc suite already holding the slot finishes normally; this change does not preempt it.

## 3. Level-of-abstraction fit

The service knows whether its verify child is preparing or running. It publishes that state to the existing host semaphore. Admission remains in the semaphore; no second slot authority is added.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new judgment authority. The modified state publication feeds the existing deterministic semaphore admission policy, a bounded resource invariant.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals judgment point. A live, uncancelled verify child is an enumerable lifecycle state.

## 5. Interactions

- **Shadowing:** the claim only affects the full-suite lane; targeted tests remain separate.
- **Double-fire:** child and coordinator claims may overlap around suite acquisition. Separate owner keys make both safe; either one suffices to preserve priority.
- **Races:** coordinator shutdown clears its own claim; a child still waiting for the suite slot retains its own claim and exits when cancelled. A peer result clears the peer claim before persisting the result. The service only latches a holder whose PID equals its live child's PID, never a different suite holder.
- **Feedback loops:** none identified. A full suite may wait at its existing 45-minute budget; no new retry loop exists.

## 6. External surfaces

Other agents on the same machine may see `mergeGatePriority.active` while the verifier prepares. Their full suites wait behind the merge gate; targeted tests do not. The claim remains host-local. No operator action or external service write is added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface is added or changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: CPU test slots belong to each host. The Studio and each peer publish their own claims to their local semaphore. A peer's result travels through the existing authenticated handoff; priority claim files do not replicate.

## 8. Rollback cost

Revert the service change and ship an update. Claims expire within two minutes if the old process disappears; no durable data migration or repair is needed.

## Conclusion

The change closes the observed preparation race while preserving the existing suite cap, timeout, stale-claim recovery, and targeted lane.

## Second-pass review (if required)

**Reviewer:** priority_review
**Independent read of the artifact: concur**

The first independent pass identified that keeping the claim through the entire run would over-block hosts configured with more than one suite slot. The service now clears its claim when it observes the child's acquired slot. The independent re-review concurred: the holder PID latch closes that concern, and no remaining release concern was found.

## Evidence pointers

- Focused unit and migration checks passed: 159 tests across service, peer, and migration files.
- The full unit tier passed on the committed branch on the M5: 51,860 tests, with 18 skips.
- `tests/integration/test-runner-limiter-route.test.ts` passed 15 route checks on the M5.
- `tests/e2e/local-verify-lifecycle.test.ts` and `tests/e2e/test-runner-limiter-lifecycle.test.ts` passed 16 production wiring checks on the M5.
- The first full M5 integration run exposed a host-core-count fixture conflict in the existing CLI-precedence probe: Vitest inferred a minimum above the probe's explicit `--maxWorkers=16`. The probe now selects the existing one-worker-minimum fixture while retaining its real five-file suite-class routing assertion. Its focused M5 rerun passed, and the independent reviewer concurred that this does not weaken the routing invariant.

## Class-Closure Declaration (display-only mirror)

This repair covers coordinator and peer preparation, cancellation, normal completion, and migration awareness. Older priority-unaware checkouts remain a known compatibility limit of the original feature.
