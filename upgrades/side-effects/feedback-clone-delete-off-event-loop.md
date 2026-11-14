# Side-Effects Review — feedback check clones are deleted in the background

**Version / slug:** `feedback-clone-delete-off-event-loop`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end)`

## Summary of the change

Tier 1. In `src/feedback-factory/execute/attemptFs.ts`, `removeAttemptTree` still renames the target into the executor's trash directory synchronously, and now deletes the parked tree on one module-level serial promise chain (`deleteParkedInBackground`) through a new `SafeFsExecutor.safeRmTreeSerial` instead of `SafeFsExecutor.safeRmSync`. `sweepTrash` queues leftovers on the same chain, skipping entries already queued. `safeRmTreeSerial` (in `src/core/SafeFsExecutor.ts`) applies the same guard and audit as `safeRm`, walks the tree depth-first awaiting each `lstat`/`readdir`/`unlink`/`rmdir` before the next, never follows a symbolic link, and falls back to `fs.promises.rm` for what is left if the walk fails. Two read-only helpers are exported from `attemptFs.ts`: `attemptTrashSettled()` (tests) and `attemptTrashPending()`. Two source files, two test files.

Why: the synchronous delete of two check clones held the server's main thread for 128 s and 59 s on 2026-11-13 18:23Z and the supervisor restarted the server; ordinary deletes that day took 5 to 20 s each.

## Decision-point inventory

None. No gate, block, filter or dispatch decision is added or changed. What is removed and when is unchanged; only when the bytes are reclaimed moves.

---

## 1. Over-block

Not applicable: nothing is rejected.

## 2. Under-block

Still synchronous after this change: the `EXDEV` fallback (the attempt's small temp directory on a Linux tmpfs `/tmp`), and `treeBytes`/clone creation, which were already asynchronous or run in child processes. Other synchronous recursive deletes in the server (`WorktreeReaper`, `UpdateChecker`, `BackupManager.removeStaging`, `SessionManager` memory scope) are outside this change; they are listed in feedback item fb-c3f35107-ca5 so the class is tracked. <!-- tracked: fb-c3f35107-ca5 -->

## 3. Level-of-abstraction fit

The change is in the one function every executor removal already goes through, so all 20 call sites get it without edits. `SafeFsExecutor` stays the only place that deletes; its guard and audit row are the same for `safeRm` and `safeRmSync`.

## 4. Signal vs authority compliance

No authority is added. `attemptTrashPending()` is a read-only count.

## 5. Interactions

- **Callers that reuse the path** (stale check clone, publish clone, dependency-cache entry, attempt temp directory): the rename frees the path before the call returns, as before.
- **`sweepTrash` every tick:** an entry already queued is skipped (`pendingTrash`), so a slow delete is not queued again on each tick; a sweep queues nothing while `limit` entries are pending, so the chain cannot grow without bound from sweeps.
- **Failure:** a rejected delete is caught on the chain (SafeFsExecutor has already written the `denied` audit row), the entry leaves the pending set, the tree stays parked, the next sweep queues it again. Later deletes still run.
- **Stop or restart mid-delete:** the partly deleted tree is in the trash directory; the next process sweeps it.
- **Disk and threadpool:** one tree at a time and one filesystem call at a time, so cleanup holds at most one of libuv's four threadpool threads. Measured beside a Local Verify run: a concurrent 5 ms `stat` probe kept its pace during the serial walk and ran eight times slower during `fs.promises.rm`. The walk is about nine times slower per tree; trees wait in the trash longer, so peak disk use is briefly higher (up to five parked trees per check). No caller measures the trash.
- **Failure visibility:** a failed delete no longer reaches `cleanup()`'s `execute:cleanup-failed` row (that row now covers the rename only); it is a `denied` row in the destructive-ops audit, and the tree is retried by every sweep. A tree that can never be deleted is retried each tick, as a leftover already was.
- **Audit caller frame:** the audit row's captured caller is now a promise-chain frame; the `operation` label still names the call site.
- **Confinement:** unchanged. The trash is under the agent's state directory, which a confined attempt can neither read nor write; a parked tree exists there for longer than before.
- **Spawn/kill:** none added. Class `unbounded-self-action`: not applicable, no process is spawned or killed and no loop acts on the agent's own sessions.

## 6. External surfaces

None. No route, message, config key or file format changes. Audit rows for these deletes now carry executor `safeRmTreeSerial` instead of `safeRmSync`, and appear when the delete ends.

## 7. Multi-machine posture

Machine-local by design: the trash directory and the queue belong to the one process that runs the feedback executor (the canonical owner). Nothing is replicated or read across machines.

## 8. Rollback cost

Revert the commit. No state migration: the trash directory layout is unchanged, and the previous code deletes whatever is parked there.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only, 2026-11-13. It read every caller of `removeAttemptTree` (25) and `sweepTrash` (1).

Verdict on the first version (background delete through `safeRm`): "Concur with the change", no blockers, one should-fix: `fs.promises.rm` fans out over a directory's children and fills the four-thread libuv pool for the length of the delete. Acted on: the delete now goes through `safeRmTreeSerial`, and the difference was measured (section 5). Its notes on failure visibility, the audit caller frame, disk bytes lingering and confinement are recorded in section 5; `attemptTrashSettled`'s comment no longer claims a shutdown use, and the test file awaits it in `afterEach`.

**Reviewer concurred:** yes, on the first version. The serial walk was added after that read in answer to its one should-fix and is covered by five new unit tests.
