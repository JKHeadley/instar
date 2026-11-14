# Side-Effects Review — Local Verify next-slot priority

**Version / slug:** `local-verify-next-slot-priority`
**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** `/root/review_next_slot_priority`

## Summary of the change

`LocalVerifyService` now keeps the host's short merge-check priority claim on a cap-one machine when its current child has the suite slot and another locally runnable entry is queued. It shares the normal queue admission decision for both starting and reserving work. `serviceSeams` compares the server's cap with the verifier child's effective cap after environment scrubbing and uses the smaller value. Unit, HTTP integration, and production lifecycle tests cover the handoff and cap boundary. This changes test-slot timing, not the verification policy or result authority.

## Decision-point inventory

- `LocalVerifyService.pump()` — modified: whether to keep or release the host suite priority claim while a verifier is in flight.
- `LocalVerifyService.nextRunnableQueuedEntry()` — extracted from the existing pump decision: the same hold, pause, version, fairness, and remote-reservation checks govern a new start and the next-slot claim.
- `HostTestRunnerSemaphore.acquire()` — pass-through: remains the sole authority that admits or waits an ordinary suite under a live claim.

## 1. Over-block

A legitimate ordinary full suite can wait while an active cap-one verifier has another runnable local check queued. That is the intended bounded priority, but a bad queue decision could make it wait unnecessarily. The shared decision returns no candidate for empty, remote-reserved, paused, held, stopped, or version-changed work. The two-minute claim expiry and 45-minute ordinary acquire budget remain. On cap-above-one hosts the coordinator does not retain this second-entry claim, preserving spare capacity.

## 2. Under-block

When both server and child resolve more than one concurrent full suite, the next queued verification still has no post-acquisition reservation; this narrow repair covers the effective cap-one path. An unreadable cap keeps the claim until the queue clears, favoring the next verifier's slot. A coordinator crash can let the claim expire before the next verify starts; the existing dead-owner/expiry behavior favors liveness.

## 3. Level-of-abstraction fit

The Local Verify coordinator owns queue readiness, while the host semaphore owns actual slot admission. The fix feeds the existing semaphore priority mechanism with the coordinator's complete queue decision. It does not introduce a second admission gate or infer readiness from a simple queue length.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change uses the existing deterministic slot authority and its full queue admission decision.

The cap-one condition is a structural host capacity fact. Queue admission already accounts for update pause, main-red hold, merge hold, remote reservation, verifier version and fairness. No brittle text detector gains blocking authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The only new boundary is the numeric suite cap equal to one; the next work candidate comes from the pre-existing, auditable queue policy.

## 5. Interactions

- **Shadowing:** The coordinator's claim is advisory to the host semaphore; the semaphore still checks live capacity and claim validity.
- **Double-fire:** A current verifier child may briefly have its own claim while the coordinator has one. Both are per-agent host claims and deduplicated by the semaphore; clearing one does not erase the other.
- **Races:** The coordinator renews on its pump cadence, and the claim has a two-minute lease. A queued entry becoming held or remote-reserved releases the coordinator's next-slot claim on the next pump. A stale claim can delay ordinary work until that pump or lease expiry, not indefinitely.
- **Feedback loops:** No result or queue record is changed by the claim. The next pump recomputes readiness from the queue and host cap.

## 6. External surfaces

Other local test runners may wait longer behind an actual queued merge check on the default one-suite host. There is no new API, user-facing notice, external service call, persistent schema, or operator action. Existing `GET /test-runner-limiter` already shows whether the merge claim is active. No new operator surface is added.

## 7. Multi-machine posture

**Machine-local by design.** Suite capacity and priority claims govern one physical machine's test slots. Each verifier machine computes its own claim from its own queue and host cap. The coordinator's existing peer dispatch and remote reservation keep peer-owned entries out of this local claim. No new user-facing notice, durable state, or URL is introduced.

## 8. Rollback cost

Revert the code and ship a patch. There is no migration or data repair. A live claim expires within two minutes after rollback or process exit. Until rollback reaches an agent, legitimate ordinary full suites may wait behind queued merge checks as described above.

## Conclusion

The repair closes an observed handoff gap on the default cap-one Studio while preserving the existing multi-slot spare-capacity behavior. The intentionally uncovered multi-slot next-run policy is documented. The current revision passed 119 focused unit tests, build, lint, and independent review. API, production wiring, full-suite and CI checks remain before ship.

## Second-pass review

**Reviewer:** `/root/review_next_slot_priority`
**Independent read of the artifact:** Found a server/child cap mismatch: the child drops the server's environment override. The seam now uses the smaller effective cap; the production lifecycle test covers server cap two with child cap one and then a shared tuning cap of two. On follow-up, the reviewer found no remaining handoff correctness issue and concurred with this review. The tests cover the service decision and production cap wiring; they do not run a real ordinary semaphore acquire across the handoff.
