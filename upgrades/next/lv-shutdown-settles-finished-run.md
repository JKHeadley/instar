# Local Verify keeps the verdict of a run that finished just before the server stopped

<!-- bump: patch -->

## What Changed

`LocalVerifyService.shutdown()` treated any in-flight run as interrupted: it sent SIGTERM to the run's group, counted an interruption, put the entry back at the head of the queue, and left the run's result file unread. A planned restart is released by `PlannedRestartVerifyGuard` as soon as the run child is no longer alive, which can be before the server has handled the child's exit event. In that window the run is finished and its result is on disk, and `shutdown()` discarded it.

`shutdown()` now reads the in-flight run's result file first. If it holds a result object, the run reached its verdict (the child writes the file with a temporary name and a rename as its last act, after its own cleanup): the server audits `settled-at-shutdown` and runs the normal exit handling, so the record is journaled before the process exits. Nothing is counted as an interruption.

Not settled when the server can see that the verifier on disk has changed (an update replaced it; a change it cannot see, or a policy change, is not covered): the restart then loads a verifier whose index ignores a record this one writes, so the run has to happen again anyway, and the interruption path keeps the entry at the head of the queue for that.

`onExit` handles a run exactly once (a `settled` latch on the in-flight object), so the child's real exit event arriving after the settle cannot record a crash over the verdict.

A run with no result file at shutdown is an interruption, exactly as before.

## What to Tell Your User

Nothing changes that you will see. When the agent's server restarts for an update just as a test run finishes, the result of that run is now kept, where before the run could be thrown away and started again.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A finished Local Verify run survives a restart that lands before its exit is handled | Automatic |

## Evidence

Studio, 2026-11-13, PR 3107 head 7c0ecf26. Run log: `run-finished` outcome `failure` at 11:04:05.169Z. `.instar/logs/local-verify.jsonl`: `cancel` reason `shutdown` at 11:04:05.290Z, then `interrupted` (interruptions 2, ranMs 1443353). `GET /local-verify/record` for that head: no record. The run was re-queued with `resumeFirst` and ran again for 31 minutes (and passed: the first verdict was a flaky e2e failure, so in this instance the lost verdict was a red one).

Tests: `tests/unit/localVerify/LocalVerifyService.test.ts`, 9 new in "a run that finished just before the server stopped": a green verdict is kept, not counted as an interruption and not re-run after the next boot; a red verdict is kept; the late exit event does not replace the verdict (fails if the latch is removed: checked); what is left of the group is swept and the next boot is not blocked; a crash result is settled as the error it is, with its retry queued and no interruption; a file that is not a result object is not a verdict; no settle when the verifier on disk changed; a run with no result is still an interruption; a temporary result file is not a verdict. 157 pass in that file (9 new). One existing test in the same file, "through the real AutoUpdater", waited a fixed 50 ms for the restart request file and failed once in four runs on a loaded machine; it now waits for the file (up to 5 s); `peerVerifier`, `waitingListService`, `mergeLineWiring`, `orphanSweep` and `mainRedHoldService` unchanged and passing (119).

## Also fixed here

`readResult` returned whatever the result file parsed to. A file holding a bare JSON string, number, boolean or array parsed without error, and the exit handler's `'degradations' in result` then threw a `TypeError` out of the exit promise: an unhandled rejection in the server and no record for the run. `readResult` now returns `null` for anything that is not a JSON object, which the exit handler already records as a crash and retries. Found because this change's own junk-file test raised that rejection: all 157 tests passed and the file still exited 1 (the Local Verify failure of this PR on 2026-11-13 16:51Z, "unit lane exit 1, 0 failed tests"). One test added; 158 pass with no unhandled error.
