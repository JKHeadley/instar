# The hourly feedback checkpoint copies its snapshot off the server's main thread

<!-- bump: patch -->

## What Changed

On the development agent that owns the feedback pipeline, a 15-minute tick takes a state snapshot when the newest one is over an hour old. `BackupManager.createSnapshot()` is synchronous, so the whole copy (about 400 MB in about 1,200 files on Echo) and the pruning of the oldest snapshot ran on the server's main thread. On a disk busy with a test run that took over a minute, the server answered no health check, and the lifeline supervisor killed it.

The hourly snapshot now runs in a worker thread (`createBackupSnapshotInWorker`, `src/core/backupSnapshotJob.ts`). Before the worker starts, the main thread takes point-in-time copies of the files that must come from one moment (`BackupManager.stageSqliteFiles()`: every SQLite database with its `-wal` and `-shm` files, and the feedback drain checkpoint record), as clones where the filesystem supports them. The worker copies those staged files in place of the live ones, copies everything else, writes the manifest, prunes, and removes the staging directory. At most one hourly snapshot is in flight (`FeedbackDrainBackupCadence.maybeHourlyOffThread`); a tick that finds one running starts nothing and warns once it has run 30 minutes.

With staging in force a database, log or journal file is never read live: one that appeared after staging is left out of that snapshot (the next one has it), and a missing staged copy fails the snapshot.

For every snapshot trigger: a snapshot that fails removes its own directory, a snapshot directory with no manifest that is over a day old is swept (a server killed mid-copy used to leave one behind for good), and the snapshot directory is created exclusively so two snapshots in one second cannot share it.

Unchanged: the snapshot layout, the manifest and its integrity hash, every deny rule (applied at staging and again at copy), and where manual, promotion and failover snapshots run (synchronously, on the caller's thread).

## What to Tell Your User

Nothing changes that you will see. On the development agent, the hourly safety copy of the feedback data no longer makes the server stop answering when the disk is busy, which had been getting the server restarted in the middle of test runs.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Hourly feedback snapshot copied off the main thread | Automatic (development agent only) |

## Evidence

Studio, 2026-11-13 01:34:59 PST, `logs/server-freeze/freeze-20261113T093459Z.txt`: three failed health checks; an 8-second JS profile of the server put 46.4% of self time in `copyFile` and 44.6% in `rmSync`, under `createSnapshot` (`BackupManager`) called from `maybeHourly` (`FeedbackDrainBackupCadence`). The supervisor killed the server and the Local Verify run in progress; the same change lost two runs in a row. The snapshot it was making holds 1,175 files, 413,514,106 bytes. The same file set copies in about 0.4 to 1.1 s on a quiet disk, cloned or plain, so the cost is contention, and a cheaper copy on the main thread would not remove it.

Tests: `tests/unit/BackupManager-staged-sources.test.ts` (22: what is staged and what is not; the snapshot holds the staged moment after the live database changes; a log that appeared after staging is left out; overlapping include entries; a missing staged copy fails and leaves no directory; staged entries staging could not have produced are ignored; deny rules hold for staged entries; same file list and byte count as an unstaged snapshot; a file that goes away mid-copy is left out with staging and still fails without it; a complete snapshot survives a failure in the housekeeping after it; a directory with a database-like name is not staged; abandoned-directory sweep; same-second ids; staging cleanup), `tests/unit/feedback-drain-backup-cadence.test.ts` (6 new: one in flight, checkpoint before staging, no disk read inside the hour, a failure frees the slot, the server wiring), `tests/integration/backup-snapshot-worker.test.ts` (3, against the compiled worker: a restorable snapshot holding the staged moment; main-thread timers fire while the copy is in progress, with a control showing none fire during the synchronous snapshot; a worker that cannot start rejects and leaves no staging). Existing backup unit tests unchanged and passing.
