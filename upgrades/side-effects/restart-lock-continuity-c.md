# Side-Effects Review — A locked testing machine is reported once (restart-lock-continuity part C.1)

**Version / slug:** `restart-lock-continuity-c`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent (new owner-facing notice; host-level shared file)`

## Summary of the change

`src/monitoring/LockWatch.ts` (new) reads the screen lock every 5 minutes on any machine that runs Local Verify, or that is enrolled unattended or proving. It reports one degradation per lock episode per host. The episode lives in `~/.instar/host-maintenance/lock-watch.json` under its own lock file, using the existing `hostSemaphoreCore` helpers with stale-lock reclaim.

How an episode is tracked:
- **Continuity:** kept on the host record. A gap with no reader longer than the interval plus 60 s restarts the hold. An `unknown` or screensaver reading interrupts the run without ending the episode.
- **Deadline reading:** an extra reading is taken at the hold deadline, re-read once if it comes back `unknown`.
- **Report claim:** the claim is marked pending, then delivered. A pending claim older than 2 minutes is reclaimed.
- **Hourly floor:** at most 3 reports per host per hour, except when the lock interrupts Local Verify work.
- **Brakes:** after 3 `unknown` readings the watch backs off to 15 minutes; after 12 it pauses.
- **Attended coordinators:** a Local Verify coordinator on an attended machine reports only while work is queued or running.

Server wiring:
- The `MachineLockStateReader` is created at startup, outside the machine-maintenance gate, and the gate reuses it. That makes `GET /machine-maintenance/lock-state` answer on the M5, where maintenance is off.
- The route now carries `lockWatch` status.

Spec: `docs/specs/restart-lock-continuity.md` C.1, approved by the Chief of Staff (msg 4f877632). C.2 (unlock re-sample) and part B (machine-away) come in a later PR.

## Decision-point inventory

- **Report or not.** A judgment-candidate with a floor. It holds no blocking authority: it only reports.

## 1. Over-block

None. Nothing is blocked.

## 2. Under-block

- A Mac that requires its password only after a delay reads `unknown` and is never reported. This is stated in the spec.
- A machine with neither Local Verify nor self-care enrolment is not watched, by design.

## 3. Level-of-abstraction fit

- The watch is wired beside Local Verify, the role that makes a lock matter.
- It reuses the shared lock reader, `readEnrolment`, `defaultDoNotMaintainPath`, the `hostSemaphoreCore` helpers and `DegradationReporter`.

## 4. Signal vs authority compliance

Signal only.

## 4b. Judgment-point check

- Hold: 10 minutes, configurable from 1 to 60 minutes.
- Floor: 3 reports per hour.
- An episode that interrupts work always reports.

## 5. Interactions

- **Machine-maintenance gate:** reuses the same reader instance.
- **`HostMaintenanceStore`:** separate file and separate lock file (`lock-watch.json.lock`, never `plan.json.lock`), so `reserve()` never contends with it.
- **`DegradationReporter`:** the feature key carries the episode id, so its one-hour mute does not silence a later episode.

## 6. External surfaces

- At most one owner-facing degradation per lock episode per host, with at most 3 an hour.
- One new host file.
- The lock-state route gains a field.

## 6b. Operator-surface quality

The notice names the machine and the time the lock started, says tests may fail while it is locked, and says it must be unlocked at its console.

## 7. Multi-machine posture

- **Proxied:** each machine reads its own lock, and the existing `?scope=pool` read shows every machine's.
- The host file is shared by the agents on one OS login.

## 8. Rollback cost

- Revert the change. The host file is inert to old code.
- No config migration: `machineMaintenance.lockReportAfterMs` is read with a code default.

## Conclusion

Read-only, with at most one report per episode. The M5, the incident machine, is covered.

## Second-pass review (if required)

Concern raised (independent reviewer, 8 points, no blockers). Applied:
1. The deadline re-read now waits 6 s, past the reader's 5 s cache, so it is a fresh reading.
2. A paused watch keeps a 15-minute check of the host file and resumes when another agent records a definite reading (`lastDefiniteReadingAt`).
3. The claimed path uses the episode it claimed, not a re-read after the lock is released.
4. The "delivered" mark retries 3 times, and a failure is logged.
5. Named in Interactions: `legacyPidDeathLockReclaim`'s documented torn-read window (`hostSemaphoreCore.ts:306-315`) can let two agents both claim; at worst one duplicate report.
6. "Interrupts work" now also covers work seen at any reading in the episode (`workSeen`), which catches a run that failed and cleared the queue.
7. The notice uses the machine's nickname (`coordinator.identity.name`), falling back to the hostname.
8. Noted: a Mac that asks for its password only after a delay reads `unknown`, so it is never reported; after 12 unknown readings the watch pauses and lifts per point 2.

Tests: 13 pass (added pause-lift, fresh deadline re-read, work-seen).

## Evidence pointers

- `tests/unit/lock-watch.test.ts`: 13 pass (hold then one report, co-resident agents, restart inherits the run, gap restarts the hold, unknown interrupts, new episode new feature, hourly floor and work bypass, attended-idle, pending reclaim, not watched, pause brake, pause lifts on another agent's reading, fresh deadline re-read, work seen keeps it reportable).
- `tests/e2e/lock-watch-wiring.test.ts`: for Local Verify.

Re-check: "I concur with the review: all eight fixes are in place." Two cleanups applied after it: the stale test count above, and a `stopped` flag so `stop()` cannot restart the loop.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** unbounded-self-action
- **closure:** guard
- **citation:** tests/unit/self-action-convergence.test.ts (ratchet)
- **how caught:** `lock-watch-report` is registered in `src/testing/selfActionRegistry.ts`: one report per lock episode per host. The episode and its delivered state are durable in the host file, so restarts and co-resident agents stay quiet, and a new report needs an unlocked reading first. Bound: 1 over 24 h of a lock that never clears.
