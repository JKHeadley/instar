# Side-Effects Review — Read-only standby scheduler startup containment

**Version / slug:** `read-only-standby-scheduler-startup`
**Date:** `2026-07-16`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `independent Codex reviewer`

## Summary of the change

`src/scheduler/JobScheduler.ts` now refuses every scheduled-job trigger while
the authoritative `StateManager` is read-only. The refusal occurs before job
gates, claims, spawns, or shared-state bookkeeping and writes only the
machine-local skip ledger. `tests/unit/job-scheduler-standby-startup.test.ts`
reproduces the startup-missed-job crash observed on a real paired Mini. Cron
and startup-missed callback boundaries also contain trigger failures, closing
the lease-demotion race between the entry check and later bookkeeping.

## Decision-point inventory

- `JobScheduler.triggerJob` — **modified** — returns `skipped` when the machine's
  authoritative state manager says it is a read-only standby.

---

## 1. Over-block

A job intentionally designed to run independently on every machine is also
skipped while that machine is read-only. This is required in the current
architecture because every scheduler execution path writes shared job state or
events; `perMachineIndependent` bypasses the cross-machine claim, not the shared
bookkeeping writes. The lease holder continues to run the job, so agent-wide
cadence is preserved. Truly machine-local standby jobs need a separate
machine-local scheduler state domain before they can safely run.

---

## 2. Under-block

This does not contain unrelated background components that write through
StateManager after demotion. It closes the scheduler's single trigger boundary,
including startup misses, cron ticks, retries, and manual scheduler triggers.
Direct code that bypasses `triggerJob` is outside the scheduler contract. A
job already spawned before demotion may still fail its own later shared writes;
that is governed by the job/session lifecycle rather than this trigger fix.

---

## 3. Level-of-abstraction fit

The trigger boundary is the correct layer: all scheduler entry paths converge
there before action, and `StateManager.readOnly` is the existing lower-level
authority derived from the fenced lease. Checking only the failing
`appendEvent` call would leave spawn and other bookkeeping paths exposed.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is a deterministic hard-invariant enforcement, not a brittle
  judgment detector.

The change does hold blocking authority, but its input is the existing
authoritative read-only state established by the fenced lease. The domain is
enumerable: shared-state-writing scheduler work either runs on a writable
machine or does not run. No message meaning, conversational intent, heuristic,
or threshold is interpreted here.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. The
check consumes a hard write-authority invariant; it does not choose between
work evidence, recency, urgency, or liveness signals.

---

## 5. Interactions

- **Shadowing:** the read-only check precedes machine scope, WS4.3 role guard,
  claims, quotas, gates, and spawns. Those paths cannot safely act on a machine
  whose shared state is already fenced.
- **Double-fire:** the later WS4.3 guard does not fire because this earlier
  invariant returns first; one skip-ledger row is produced.
- **Races:** `StateManager.readOnly` is read live at every trigger. A demotion
  before the boundary skips. If demotion lands after the check, StateManager
  still refuses the later write and the cron/startup-missed callback boundaries
  contain that rejection rather than allowing an unhandled process rejection.
- **Feedback loops:** the machine-local skip ledger does not alter the lease or
  cause another trigger.

---

## 6. External surfaces

The visible effect is that a standby stays healthy and reports a scheduler job
as skipped instead of crash-looping. No API schema, Telegram message, database
schema, external integration, or operator action changes. There are no new
operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** the decision is evaluated separately on each
machine from that machine's live fenced-lease-derived read-only state. The skip
ledger is also machine-local observability. The behavior converges by authority:
the writable lease holder runs the job and every read-only peer skips it. The
change emits no user-facing notice, introduces no durable transferable state,
and generates no URL.

---

## 8. Rollback cost

Pure code rollback: revert the trigger-boundary check and ship a patch. There is
no migration or state repair. During rollback propagation, affected standbys
can resume the prior crash loop when missed jobs are present.

---

## Conclusion

The fix is narrow and clear to ship. The review moved the check to the common
trigger boundary and confirmed that the authoritative lease-derived read-only
state—not a new heuristic—owns the decision. Focused scheduler tests and a clean
typecheck cover the changed path.

---

## Second-pass review (if required)

**Reviewer:** independent Codex reviewer
**Independent read of the artifact:** concur

The first pass found a check-then-act demotion window and noted that the
original test proved only a direct trigger, not delayed startup containment.
The implementation now catches trigger failures at cron and startup-missed
process-lifetime boundaries, and the ratchet adds an in-flight gate/demotion
case plus an exact single skip-row assertion. The independent re-review found
no remaining concern across authority boundaries, active-active behavior, or
self-action convergence.

---

## Evidence pointers

- `tests/unit/job-scheduler-standby-startup.test.ts`
- `tests/unit/job-scheduler-role-guard.test.ts`
- Real Mini terminal: `StateManager is read-only ... Blocked: appendEvent` from
  `JobScheduler.runGateAsync -> triggerJob -> checkMissedJobs`.

---

## Class-Closure Declaration (display-only mirror)

This modifies the scheduler, a self-triggered controller. `defectClass:
unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType:
ratchet, citation: tests/unit/job-scheduler-standby-startup.test.ts, howCaught:
the ratchet covers both demotion before a missed trigger and demotion while its
gate is in flight, requires the evaluation to settle without rejection, and
proves zero spawned sessions plus exactly one local skip for the stable-standby
case; cron and startup callbacks contain any remaining trigger error }`.
