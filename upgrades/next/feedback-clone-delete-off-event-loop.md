# Feedback check clones are deleted in the background

<!-- bump: patch -->

## What Changed

`removeAttemptTree` (`src/feedback-factory/execute/attemptFs.ts`) removes everything the feedback executor creates: attempt workspaces, check clones, publish clones, dependency-cache entries. It moves the tree into the executor's trash directory and then deletes it. The delete was a synchronous recursive `SafeFsExecutor.safeRmSync` on the server's main thread.

The move is unchanged and still synchronous, so the path is free when the call returns. The delete of the parked tree now runs in the background on one serial queue, one tree at a time, through a new `SafeFsExecutor.safeRmTreeSerial`: same guard, same audit row, and one awaited filesystem call at a time. `sweepTrash`, which the executor calls on every tick to clear leftovers, queues them on the same queue (never twice) instead of deleting them in place; its return value is now the number newly queued.

Why not the existing async `safeRm`: `fs.promises.rm` starts a call for every child of a directory at once, which fills libuv's four threadpool threads for the length of the delete; the server's other async file reads and its DNS lookups wait behind it. `safeRmTreeSerial` holds at most one of the four. If its walk fails part-way it finishes with `fs.promises.rm`. It never follows a symbolic link.

Unchanged: the cross-device fallback (`EXDEV`, a tmpfs `/tmp` on Linux) still deletes the attempt's small temp directory in place.

Two helpers are exported for tests and diagnostics: `attemptTrashSettled()` and `attemptTrashPending()`.

## What to Tell Your User

Nothing changes that you will see. The agent sometimes stopped answering for seconds, and once for three minutes, while it cleaned up after checking a fix for a bug report. That cleanup now happens in the background.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Feedback executor cleanup no longer blocks the server | Automatic |

## Evidence

Studio, `.instar/audit/destructive-ops.jsonl`, operation `feedback-execute check clone cleanup`, 2026-11-13 (UTC): each delete is bracketed by two audit rows for the same target. Durations: 5 s, 5 s, 11 s (14:28), 14 s, 14 s (15:05), 11 s, 20 s (15:32), 7 s (15:38), 7 s (16:49), then 128 s and 59 s (18:23:11 to 18:26:18) while a Local Verify run that started at 18:18:33 was writing to the same disk. A native stack sample of the unresponsive server at 18:26 shows the main thread in `node::fs::RmSync` -> `unlinkat` for all 2,404 samples. The supervisor restarted the server at about 18:26; the Studio's run of PR 3145 was cut and the peer's run of PR 3144 was abandoned (`peer-attempt-abandoned`, reason `lease-changed`).

Measured on the Studio while a Local Verify run was writing (a 9,540-entry copy of real dependencies, a probe issuing one `stat` every 5 ms beside the delete): the serial walk took 7.5 s and the probe kept its pace (1,290 probes, about 5.8 ms each); `fs.promises.rm` took 0.86 s and the probe got 20 calls through, about 43 ms each, eight times slower. Worst event-loop delay was 9 ms and 11 ms. The serial walk is about nine times slower per tree, which is the intended trade: cleanup is background work.

Tests: `tests/unit/feedback-factory/execute-units.test.ts`, 3 new and 1 extended: removal never calls the synchronous delete and leaves every source path free at once; three trees are deleted one at a time (peak concurrency 1); a failed background delete leaves the tree parked, does not stop later deletes, and the next sweep clears it; a sweep does not queue the same leftover twice and respects its limit. `tests/unit/SafeFsExecutor.test.ts`, 5 new for `safeRmTreeSerial`: nested tree, single file and missing target; never more than one filesystem call in flight; symbolic links removed and not followed; a mid-walk failure finishes through the ordinary remove; the source-tree guard refuses before touching disk. The three files pass together (113 tests).
