# Side-Effects Review — the hourly feedback checkpoint copies its snapshot off the main thread

**Version / slug:** `backup-snapshot-off-main-thread`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (a revert undoes it; no stored data changes shape; no config; the off-thread path runs only on the development agent). 5 source files (2 new), 3 test files (2 new). No spec review rounds; three independent review reads of the code (the first raised five should-fix findings, all applied; the third concurred).

`BackupManager.createSnapshot()` is synchronous. The development agent's hourly feedback checkpoint used it from a timer on the server's main thread: about 400 MB in about 1,200 files copied, then the oldest snapshot deleted. On 2026-11-13 01:35 PST, with the disk busy under a test run, that held the event loop for over a minute; the lifeline supervisor killed the server and the Local Verify run in progress (profile: 46.4% `copyFile`, 44.6% `rmSync`, under `createSnapshot` from `maybeHourly`).

Change: the hourly snapshot runs in a worker thread. The main thread first stages point-in-time copies of every SQLite file and the drain checkpoint record in the included set (`stageSqliteFiles`), the worker copies the staged files in place of the live ones plus everything else, writes the manifest, prunes, and removes the staging directory. One hourly snapshot in flight at a time. Manual, promotion and failover snapshots are unchanged and synchronous.

This removes one measured cause of the freeze kills, not all of them. CMT-1718 tracks the others (synchronous tmux and ps reads, a synchronous directory walk, the supervisor's cleanup of a live verify child).

## Decision-point inventory

None added or changed. The cadence rule (snapshot when the newest is over an hour old, canonical owner only) is the same rule; it gains one state, "one already in flight", which starts nothing. Every backup deny layer is unchanged.

## 1. Over-block

- A tick that finds a snapshot in flight starts none. If a worker never finishes, no further hourly snapshot starts for the life of the process; the server warns on every tick once it has run 30 minutes. Promotion and failover snapshots do not go through this slot and are not held.
- An unstaged and a staged snapshot of the same quiet state list the same files and bytes (tested). In the off-thread snapshot only, three kinds of file are left out on purpose: a database, log or journal file that did not exist when staging ran (it belongs to a later moment than the staged database beside it; the next hourly snapshot has it); a file that was listed and then renamed or removed before its copy (counted in one log line per snapshot); and a staged entry that staging could not have produced.

## 2. Under-block

- **Files other than databases are read live by the worker.** Before, the process was blocked for the whole copy, so no write from this process could land between two files. Now a file this process appends to or rewrites while the worker runs (`feedback.jsonl`, `clusters.jsonl`, the generation files, JSON sidecars) is copied as it is at the moment the worker reaches it, which can be later than the staged database. Writes from other processes could always land mid-copy; writes from this process now can too. The staged set covers the files whose mutual consistency a restore verifies (the drain database, its log, and the checkpoint record that carries the database checksum).
- Promotion, failover and manual snapshots still block the main thread for the copy. They are rare and their callers wait for the result; they are not part of the hourly freeze.
- The checkpoint that precedes the snapshot (`checkpointForBackup`: a WAL truncate, an integrity check and a read of the 22 MB database for its checksum) still runs on the main thread.
- Staging runs on the main thread. On a filesystem with clones (APFS, btrfs, XFS with reflink) it is a few metadata operations. On one without (ext4), `COPYFILE_FICLONE` falls back to a real copy of the database files (about 235 MB on Echo, mostly `topic-memory.db`), still synchronous. The development agent's lease holder is a Mac today; a Linux holder would keep that part of the stall.

## 3. Level-of-abstraction fit

The snapshot logic stays in `BackupManager`; the worker entry holds none (same shape as `storeSnapshotBuild.worker.ts`). Staging lives in `BackupManager` because it must share the deny layers and the include resolution. The in-flight rule lives in the cadence class that already owns "at most hourly".

## 4. Signal vs authority compliance

Not a decision point: no gate, filter or block is added. The deny layers keep their authority and are applied at staging and again at copy, including for a staged entry.

## 4b. Judgment-point check

Not applicable: no judgment call is replaced by a rule. The one deliberate non-rule: no timer kills a slow worker (a killed copy leaves a directory with no manifest, and slowness is the condition this exists to survive); a long run is reported, not acted on.

## 5. Interactions

- **Pruning now happens in the worker.** `listSnapshots()` on the main thread can run while a directory is being removed; it skips a directory with no readable manifest, as before.
- **A synchronous snapshot (promotion, failover, manual, auto-session) can run while a worker snapshot is in flight.** Snapshot ids are per second with a counter suffix on collision, checked at creation; both may prune; both removals go through `SafeFsExecutor` with `force`.
- **Restore while the worker prunes.** A restore of the oldest snapshot at the moment the worker removes it can find files already gone and skips them (`restoreSnapshot` skips a missing source, as it always has). Before this change the prune ran on the same thread as a restore and could not interleave. It needs a restore of the oldest of 20 snapshots within the second or so of a prune; restore is a rare operator action and refuses to run while sessions are active. Not changed here.
- **A snapshot that fails now removes its own directory**, and a snapshot directory with no manifest that is over a day old is swept after each snapshot (a server killed mid-copy left one behind before this change too, and nothing removed it). The day bound keeps a copy still in progress safe. This applies to every snapshot trigger, not only the hourly one.
- **Snapshot directories are claimed with an exclusive create**, so two snapshots in the same second cannot share one (the old check-then-create could).
- **Staging directories** start with a dot, so they never match the snapshot id pattern: not listed, not pruned, not restorable. One is removed when its snapshot ends (success or failure) and any older than an hour is swept by a later snapshot.
- **Shutdown.** The timer is cleared as before. The worker is neither awaited nor terminated by `stop()`. The server's shutdown paths end in `process.exit`, which ends the worker with the process; an embedder that waits for a natural drain instead would wait for a copy in flight to end. An interrupted copy leaves a directory with no manifest, which the day-old sweep removes.

## 6. External surfaces

None. Same snapshot layout, manifest and integrity hash; no route, message or config change. `createSnapshot` gains an optional second argument. `isPointInTimeFile`, `stageSqliteFiles`, `removeStaging`, `sweepStaleStaging` and `sweepAbandonedSnapshots` are new exports or public methods with no caller outside this change.

## 7. Multi-machine posture

Machine-local by design: the hourly checkpoint runs only on the machine that holds the feedback pipeline's canonical lease, and snapshots are local directories. Unchanged by this.

## 8. Rollback cost

Revert the commit. Snapshots made either way are the same format. A leftover staging directory is inert and can be deleted.

## Conclusion

Moves a 400 MB synchronous copy and a recursive delete off the server's main thread, keeping point-in-time consistency for the database files by staging them first. The cost is that non-database files are no longer frozen against this process's own writes during the copy. Ship, and continue CMT-1718.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only, given the code and the questions, not the conclusion).

**Round 1: Concern raised.** Five should-fix findings, all applied:

1. A point-in-time file with no staged copy was read live (a log that appeared after staging could be paired with an older database; overlapping include entries lost the staged copy on second use; a missing staged path fell back to live). Now: with staging in force such a file is never read live, a missing staged copy fails the snapshot, and staged keys are not consumed.
2. A failed or killed snapshot left a full-size directory with no manifest that nothing removed, and the off-thread walk could fail on a file removed mid-copy. Now: cleanup on throw, a day-old sweep of manifest-less snapshot directories, and a vanished file is left out and counted.
3. The "main thread keeps turning" test would have passed for a synchronous copy. Now it counts main-thread timer ticks that fire while a snapshot directory has no manifest, with a control asserting zero for the synchronous snapshot.
4. The loop over leftover staged entries trusted its keys. Now every staged entry is validated up front (point-in-time name, not denied, plain normalized relative key, copy directly inside one of this manager's staging directories).
5. Two snapshots in one second could share a directory. Now the directory is created exclusively. The restore-while-pruning interleave is written up in section 5 and not changed.

**Round 2: no blocker; "Concern raised (minor)".** All five confirmed closed in the code. New items, applied: `worker.unref()` was a no-op as placed and its comment was wrong (removed; section 5 states the real shutdown behaviour); a failure after the manifest was written could have removed a complete snapshot (the cleanup now ends before pruning; tested); vanished files are now counted in one log line and the tolerance has unit tests on both sides; a directory with a database-like name no longer fails staging; this document was brought up to date. Break attempts on the abandoned-directory sweep, on files skipped as unstaged, and on callers that pass no staged sources found nothing.

**Round 3: Concur.** The reviewer verified each round-2 item in the code and this document, and raised only two wording items (this section's round count, and the test count in the release note), both corrected.

**Reviewer concurred:** yes (round 3).

## Scanner follow-up (2026-11-13)

The staging sweep's two catch blocks (unreadable backups directory, staging directory gone mid-sweep) now carry `@silent-fallback-ok` reasons. Comment-only; no behaviour change. Found by Local Verify (`tests/unit/no-silent-fallbacks`, 496 over a 494 baseline).

## Merge with main (2026-11-13)

Main gained PR 3136 (usage-ledger scan), which adds an import on the line next to this change's import in `src/server/AgentServer.ts`. Both imports are kept; nothing else conflicted. Type check clean; the 35 unit tests of this change and the fallback scanner pass on the merged tree.
