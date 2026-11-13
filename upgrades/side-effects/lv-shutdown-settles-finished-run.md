# Side-Effects Review — Local Verify keeps the verdict of a run that finished just before the server stopped

**Version / slug:** `lv-shutdown-settles-finished-run`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (one branch in `shutdown()`, one latch in `onExit`; a revert undoes it; no stored data or config changes), with an independent second-pass review because the file is part of the verification harness. 1 source file, 1 test file (9 new cases). No spec review rounds.

`LocalVerifyService.shutdown()` treated every in-flight run as interrupted and left its result file unread. `PlannedRestartVerifyGuard` releases a planned restart when the run child is no longer alive, which can be before the server has handled the child's exit event. On 2026-11-13 a run was cancelled 121 ms after its verdict was written; the verdict was discarded and the 24-minute run ran again.

Change: at shutdown, a run whose result file already holds a result object is settled through the normal exit handling, unless the verifier on disk has changed. `onExit` handles a run exactly once.

Part of CMT-1718 (runs lost to restarts). Not fixed here, and tracked there and in the feedback filed for this incident: the guard still releases in the gap; a server that is killed never runs `shutdown()`, and the next boot does not adopt a finished result (`reapOrphan` clears the marker without reading it, the queue restore counts an interruption, and the result file is left in the runs directory).

## Decision-point inventory

- **Whether a stopping server records a run's verdict or counts an interruption.** New rule: record it when the child's result object is on disk and the verifier on disk is unchanged; otherwise as before.
- **What the record says** is decided by the child's result and `complete()`'s existing validation, exactly as on the normal exit path. No verdict is produced or altered here.

## 1. Over-block

No issue identified. A run with no result, a result that is not an object with a `kind`, a cancelled run, and any run while the verifier on disk has changed all take the previous interruption path.

## 2. Under-block

- A server stopped by SIGKILL, by the shutdown deadline's `process.exit`, or by a crash never reaches this code. A result written in that gap is still discarded on the next boot.
- The guard-side cause remains: a marker with a dead child means "finished, not yet handled" and should hold a restart for a short bound.
- A green verdict settled here is journaled but not merged by the stopping server (the merge hand-off refuses while stopping). The next boot posts the status from the journal and the merge watcher picks the PR up through its usual checks.

## 3. Level-of-abstraction fit

The service owns both the in-flight run and its shutdown, and already owns the exit handling the settle reuses. The alternative the reviewer raised, adopting the result in the boot-time orphan reap, would cover the killed-server case too; it changes the boot and queue-restore sequence and is left for its own change.

## 4. Signal vs authority compliance

No new authority and no new check. The settle runs the same `onExit` to `complete()` path with the same record validation. It cannot start a merge. The condition that selects it reads the child's own result file, bound to this run by a fresh token in its name, and the on-disk verifier version.

False-green question, answered by the reviewer from the code: the normal path never consults the exit status either, so passing none loses no check; the result path is per-spawn and written by rename, so a stale or partial file cannot be read as a verdict; a cancelled run is excluded, and the child has no SIGTERM handler that could write a result after a cancel.

## 4b. Judgment-point check

Not applicable.

## 5. Interactions

- **The late exit event.** The child's real exit can arrive after the settle. The `settled` latch makes `onExit` return at once; without it the handler would find the result file gone and journal a crash over the verdict (a test fails if the latch is removed; checked).
- **What `onExit` does while stopping.** `pump()` only persists the queue; replay admission and dispatch refuse while stopped; the merge hand-off refuses; an error result re-queues its retry at the head, which the trailing `persistQueue()` then saves (legitimate, and without an interruption count); `rearmMainAfterGreen` can only push a `main` entry, which is never persisted. A status post may be fired at a reconciler that has already stopped; the boot pass posts it.
- **The in-flight marker is cleared by the settle**, so the next boot's orphan reap has nothing to block on. Whatever is left of the group is swept with SIGKILL by `onExit`, as after any finished run; the child has nothing left to do after writing its result.
- **Peer attempts and `main` runs** go through the same handler: a peer attempt's record is written as done where before it was tombstoned at boot; a `main` run completes through `completeMain`.
- **The verifier check is the existing `verifierChangedOnDisk()`.** An unknown on-disk version answers "not changed", so the run is settled and the next boot's index decides whether the record counts (worst case: the record is ignored and the watcher re-requests the PR, which then loses its queue place; never a false green). A changed policy hash is not detected by this check and has the same worst case. When the check does find a change it enters the verifier hold and audits `verifier-changed` with `where: 'before-start'`, a misleading label in a stopping process; and the finished run then takes the interruption path, which counts an interruption for a run that was not interrupted. Both are the previous behaviour for that case.
- **A crash result written by the child** is settled as the error it is: one error retry is spent where the old path counted an interruption, within the existing retry bound.
- **A verifier-mismatch result** is not settled in practice: it is written when the verifier on disk has changed, which is the condition that routes to the interruption path.

- **One existing test hardened.** "through the real AutoUpdater ... the restart then goes ahead" slept a fixed 50 ms before asserting the restart request file exists; under load that was sometimes too short (1 failure in 4 runs here). It now polls for the file for up to 5 s. The assertion is unchanged. A change to this file gets no isolation re-run in Local Verify, so a timing-dependent test in it would otherwise decide this PR's verdict.

## 6. External surfaces

None. One new audit event (`settled-at-shutdown`).

## 7. Multi-machine posture

Machine-local by design: each machine's service settles its own in-flight run. A peer's settled attempt is persisted as done in the existing peer-state file and kept by the next boot (the reviewer checked that much; the coordinator's poll of it is the existing route and was not re-examined).

## 8. Rollback cost

Revert the commit.

## Conclusion

A finished run's verdict is no longer discarded by a graceful stop that lands before its exit is handled. Ship. The killed-server case and the guard-side gap stay open under CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only; it read the code and did not run the tests, so the pass counts in the release note are mine).

**Round 1: Concur, no blocker.** It walked `onExit` with the service stopped for every kind of entry and result and found every journal, queue and peer-state write synchronous (one exception it noted: a green `main` verdict while main health is red awaits an ancestry check before the health write; if lost, `main` is verified again on boot) and the persisted queue correct, and no ordering that records a verdict the normal path would not. Should-fix findings and what I did:

1. The cause remains and only a graceful stop is covered (the guard gap; a killed server; boot does not adopt a finished result). Not changed here; stated in sections 2 and 3 and the summary.
2. A green verdict settled at shutdown is wasted, and loses its queue place, if the restart loads a different verifier. Fixed: no settle when the verifier on disk has changed.
3. My first version sent SIGTERM and skipped the sweep, on the premise that the child might still be cleaning up. The premise was wrong (the result write is the child's last act), and it left a surviving group untracked. Fixed: the normal sweep is used.
4. Test gaps. Added: a crash result, a non-result file in five shapes, the verifier-changed case, the swept group with a boot afterwards. Not tested at shutdown: `requeue`, a `main` run, a peer attempt and a preflight-replay entry. They go through code the settle shares with the normal exit, whose own tests run with the service not stopping.

Nits applied: the result must be an object with a string `kind`; the doc comment above `shutdown()` describes both paths.

**Round 2: Concur.** Fixes verified in the code. No state in which a finished run is neither settled nor interrupted; settling a crash result as an error judged right. Document corrections applied (the selecting condition also reads the verifier version; the scope of "synchronous"; what is and is not tested at shutdown; what was verified about peer attempts; the limits of the verifier check), and one test assertion that could pass vacuously was tightened.

**Reviewer concurred:** yes (both rounds).

