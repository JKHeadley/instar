# Side-effects review

## Summary of the change

Add a background queue maintenance check that reconciles tracked job sessions and records stalled queue progress.

## Decision-point inventory

A job session is complete when an authoritative terminal lookup shows it is absent, or all of its panes are dead with terminal status or an absent process. The queue alert requires a nonempty queue beyond the longest local job timeout.

## 1. Over-block

An inconclusive terminal lookup keeps the job in capacity. The queue alert identifies a prolonged blockage for investigation.

## 2. Under-block

A terminal can close its descriptors before exiting. The status-free branch requires an absent process, and every pane must satisfy the terminal check.

## 3. Level-of-abstraction fit

SessionManager owns completion. The scheduler asks it to reconcile and uses the existing admission path to advance the queue.

## 4. Signal vs authority compliance

The alert is a signal for the agent. A confirmed process exit permits the ordinary completion state transition. Current-session identity and machine write eligibility are rechecked before that transition.

## 4b. Judgment-point check

A transient terminal error or ambiguous process observation is insufficient for automatic completion.

## 5. Interactions

The existing completion event wakes queued work. Normal job admission, quota, machine scope, and claim checks still apply. Queue maintenance allows one in-flight pass.

## 6. External surfaces

The scheduler writes an activity event and a server warning for agent investigation.

## 7. Multi-machine posture

Only the running, writable scheduler checks its local queue. The session probe uses the local terminal manager.

## 8. Rollback cost

Revert these changes to return queue wakeups and session completion to their existing cadence. No schema migration is required.

## Conclusion

The automatic transition uses observed process termination. The elapsed-time alert provides a diagnostic when automatic recovery cannot make progress.

## Second-pass review

Concur with the revised side-effects review. The backstop records a retained nonzero exit as failed, uses asynchronous capture, and records the stall as a historical warning and activity event. The production completion listener wakes the existing scheduler queue.

## Class-Closure Declaration

The `unbounded-self-action` defect class is closed by the convergence guard in `tests/unit/self-action-convergence.test.ts`. There is one maintenance pass in flight and one stall record per queue episode. Confirmed dead sessions leave the running set through normal completion. Uncertain probes leave the slot held.

The convergence registry uses the existing job notification verb. The production activity event keeps its scheduler-specific name.
