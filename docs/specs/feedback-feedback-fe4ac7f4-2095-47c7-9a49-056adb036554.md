---
title: Runner-enforced write-resource locks for jobs that write shared workspace files
slug: feedback-feedback-fe4ac7f4-2095-47c7-9a49-056adb036554
status: draft
initiative: feedback-fe4ac7f4-2095-47c7-9a49-056adb036554
cluster: cluster-builtin-job-bodies-that-write-shared-workspace-files-need-a
component: Job runner shared-file write coordination
severity: critical
---

# Runner-enforced write-resource locks for jobs that write shared workspace files

## 1. Problem

Several scheduled jobs with different slugs do read-modify-write edits on the same
workspace file. In the reporting install the file is `.instar/MEMORY.md`. Nothing
in the scheduler stops two of these jobs from running at the same time:

- The scheduler's concurrency guards are all **per slug**: `scriptInFlight`
  (`src/scheduler/JobScheduler.ts:219`), the live-session check in `triggerJob`
  (`JobScheduler.ts:1185`), and the multi-machine claim (`takeClaim`,
  `JobScheduler.ts:1380`). None of them can see that `insight-harvest` and
  `reflection-trigger` touch the same file.
- The only protection available today is a cooperative advisory lock that the
  job **body** has to call. Builtin bodies cannot be changed durably.
  `InstallBuiltinJobs` rebuilds each builtin manifest from template frontmatter
  on every update and keeps only `enabled`, `disabledAtBodyHash` and the
  operator's schedule (`src/scheduler/InstallBuiltinJobs.ts:200-336`). On top of
  that, the builtin wins same-slug precedence in `AgentMdJobLoader`, so a
  user-origin override at the same slug never takes effect.
- A cooperative lock with partial coverage gives **no protection** for any pair
  that includes a non-participant. The participant's acquire succeeds exactly
  when the non-participant is mid-write, so the participant goes ahead believing
  it is alone.

The result is lost updates: one job's rewrite replaces the other's.

## 2. Evidence

One report (2026-08-29). The text is untrusted and was scrubbed. What it claims:

1. A concurrent rewrite of `MEMORY.md` silently dropped the index pointers to 11
   memory files.
2. 4 enabled jobs write `MEMORY.md`. Only the 2 user-origin ones use the
   cooperative lock. The 2 that don't, `insight-harvest` and `overseer-learning`,
   are builtins.
3. A local body edit to a builtin was reverted by an update about 5.5 hours
   later.
4. `insight-harvest` (`0 */8`) is scheduled 10 minutes after `reflection-scan`
   (`50 */4`, a user job) to avoid racing it. In the same workspace, an overlap of
   12m14s was measured on a file-editing job, which is longer than that 10-minute
   gap.
5. Requested fix: a `writes:` field that the **runner** acquires before spawning
   and releases when the run reaches a terminal state.

Checks against this tree:

- `src/scaffold/templates/jobs/instar/insight-harvest.md:34` tells the session to
  "update MEMORY.md". `reflection-trigger.md` appends to `.instar/MEMORY.md` and
  declares it under `conditionalEffects`, which is an audit field with no effect on
  coordination.
- The shipped `overseer-learning.md` body only *reads about* MEMORY.md updates.
  It runs with `unrestrictedTools: true`, so its model session *can* write the
  file, and the reporter saw it doing so. **Evidence gap:** the report doesn't say
  whether that write comes from the shipped prompt or from model initiative.
- The evidence is marked incomplete. There is no reproduction log of the
  11-pointer loss, and we don't know the names of the user-origin writers or how
  their cooperative lock works. This spec therefore does not depend on how that
  lock is built (see §4.8).
- The report explicitly separates this from the known same-slug `processQueue`
  gap. That gap is out of scope here (§8).

## 3. Execution paths that must be covered

`triggerJob` dispatches a run in three different ways. All three must be covered:

| Kind | Entry | Process | Terminal signal today |
|---|---|---|---|
| `session` | `spawnJobSession` (`JobScheduler.ts:2866`) | tmux-hosted model session, which **survives a server restart** | `notifyJobComplete` (`:3332`), driven by SessionManager `sessionComplete` |
| `script` (legacy `execute.type: script`) | `runScriptJob` (`:1929`) | `/bin/sh -c` via `execFileAsync`, a child of the server | promise settle (`.then`/`.catch`) |
| `script-runner` (`runner: script` builtins) | `runScriptRunnerJob` (`:2450`) via `executeScript` (`:2379`) | `node <script>.mjs` via `execFile`, a child of the server | `.finally` at `:2560` |

The two script kinds share some important facts:

- Neither one is a "session". A liveness rule that only asks the SessionManager
  would wrongly judge a running script dead. **That was the defect in the previous
  draft of this spec (review of PR #3022), and §4.5 fixes it.**
- `execFile`'s `timeout` sends a signal only to the direct child. Any processes
  that `sh -c` started can keep running and keep writing after the scheduler
  thinks the run is over.
- If the server crashes, the child processes are not necessarily killed. A script
  can outlive the server that started it.

## 4. Proposed design

### 4.1 Declaration: `writes:`

- New optional field on job definitions, `writes: string[]`. It is accepted in
  agentmd frontmatter, per-slug manifests and legacy `jobs.json`.
- Each entry is a path relative to the project root, for example
  `.instar/MEMORY.md`. Validation runs in the loader, using the same funnel as the
  other manifest fields:
  - The path is resolved and canonicalised with `path.resolve` plus `realpath` of
    the parent directory when it exists. It must stay inside the project root.
    Absolute paths, `..` escapes, globs and an empty string are rejected with a
    load problem. The job still loads, but its manifest is marked invalid and it
    is not run (fail-closed). This matches how the loader treats other invalid
    fields.
  - The resource key is `sha256(canonicalPath)`. Two spellings of the same file
    map to one lock.
  - At most 8 entries per job.
- `buildPerSlugManifest` and `InstallBuiltinJobs` carry `writes` from template
  frontmatter. Because the manifest is rebuilt from frontmatter on every update,
  the declaration **survives regeneration by construction**. This is the property
  the reporter says body-level locks cannot have.
- Operators can add resources, but cannot remove them. A new config key
  `scheduler.extraWrites: { [slug]: string[] }` is unioned with the declared list
  at load time. This lets an operator cover a builtin whose template does not
  declare a write yet, without editing `.instar/jobs/instar/`. Nothing can
  subtract a resource a template declares.

Template updates shipped with the change:

- `insight-harvest.md`: `writes: [.instar/MEMORY.md]`
- `reflection-trigger.md`: `writes: [.instar/MEMORY.md]`
- `overseer-learning.md`: `writes: [.instar/MEMORY.md]`. It is declared
  conservatively, because the session has unrestricted tools and was observed
  writing. The only cost is serialisation with the other two.

### 4.2 Lock store

- Directory: `.instar/state/write-locks/`. One file per held resource, named
  `<resourceKey>.json`. The store is **host-local** (§4.6, foreign hosts).
- Acquire creates the file with `fs.openSync(path, 'wx')`, which uses `O_EXCL`.
  The file is never overwritten in place. Holder updates are written to a temp
  file and moved over with `rename`, only by the owning scheduler.
- Holder record:

  ```ts
  interface WriteLockHolder {
    v: 1;
    resource: string;            // canonical path, for display
    resourceKey: string;
    slug: string;
    runId: string;
    kind: 'session' | 'script' | 'script-runner';
    phase: 'starting' | 'running';
    hostname: string;
    serverPid: number;           // scheduler that acquired
    serverStartedAt: number;     // readPidStartedAt(serverPid) — pid-reuse guard
    tmuxSession?: string;        // kind === 'session'
    childPid?: number;           // kind !== 'session'
    childPgid?: number;          //   = childPid (spawned detached, see §4.5)
    childStartedAt?: number;     //   readPidStartedAt(childPid)
    acquiredAt: string;
    hardCeilingAt: string;       // §4.5 rule 5
  }
  ```

- A job that declares several resources acquires them **in sorted resourceKey
  order, all or nothing**. If any acquire fails, every file this attempt already
  created is removed before returning. Sorted order rules out deadlock between two
  multi-resource jobs.
- A single in-memory map, `heldWriteLocks: Map<runId, resourceKey[]>`, is the
  scheduler's own view. The files are the durable truth.

### 4.3 Acquire and release points

Acquire happens inside `triggerJob`, **after** `takeClaim` succeeds and
**before** any process is spawned, on all three paths:

1. Session path: just before `spawnJobSession`. Phase `starting`. Once the tmux
   session name is known, the record moves to `running` with `tmuxSession` set.
2. Script-runner path: just before `runScriptRunnerJob`. Phase `starting`. Right
   after `execFile` returns a `ChildProcess`, the record moves to `running` with
   `childPid`/`childPgid`/`childStartedAt` set. That is synchronous, before the
   first event-loop turn.
3. Legacy script path: the same as 2, around `runScriptJob`'s spawn. This means
   switching from the promisified `execFileAsync` to callback `execFile`, so the
   `ChildProcess` handle is available.

If a resource is busy, `triggerJob` releases the claim it just took (with the
existing `releaseClaim(slug, 'waited')`), records skip reason
`write-resource-busy` with the holder's slug in metadata, and enqueues (§4.4).

Release happens on every terminal path for the run. It is keyed by `runId`, so a
late release from an old run can never remove a newer run's lock: the file is
removed only if `holder.runId` matches. Terminal paths:

- session: `notifyJobComplete`, the reaper (`reapStuckRuns`) and session kill on
  timeout;
- script / script-runner: the settle callback, which fires **only after the
  process group is confirmed gone** (§4.5 rule 3). The callback alone is not
  enough;
- spawn failure: the `catch` around spawn.

After a release, `processQueue()` is called so waiters wake up immediately.

### 4.4 Queue behaviour

- A run refused for `write-resource-busy` is enqueued with a new
  `resourceWait: string[]` (resource keys) on `QueuedJob`. The existing de-dupe
  applies, so a slug is queued at most once.
- `processQueue` today shifts only the head. It changes to scan the queue in
  existing priority order and **skip entries whose `resourceWait` keys are still
  held**. That avoids head-of-line blocking: an unrelated job behind a blocked
  one can still start. Entries without `resourceWait` behave exactly as today.
- Wait bound: a waiting entry is dropped, with `job_skipped` reason
  `write-resource-timeout`, after `max(60 min, 2 × holder.expectedDurationMinutes)`
  or when its next cron fire arrives, whichever comes first. A fresh cron fire
  re-enters `triggerJob` normally. Runs are coalesced and never stacked.
- Waiting does not count against `maxParallelJobs`. A waiting job holds no
  session slot and no claim.

### 4.5 Liveness: when a lock may be reclaimed

A lock is reclaimed **only on positive evidence that its holder can no longer
write**. Being unable to probe always means *keep*. Rules, by holder kind:

1. **`session`**: the holder is alive while
   `SessionManager.isSessionAliveAsync(tmuxSession)` says alive. That check is
   tri-state, and `unknown` means alive. A dead verdict must be seen twice, on two
   monitor ticks at least 30 s apart, before reclaim. This mirrors the existing
   zombie-session handling and absorbs a slow tmux.
2. **`script` / `script-runner`, phase `running`**: the holder is alive while
   **either** of these holds:
   - `childPid` is alive **and** `readPidStartedAt(childPid)` is within
     `PID_START_MISMATCH_MS` of `childStartedAt`. These are the existing
     pid-reuse-guarded helpers in `src/core/SingleInstanceLock.ts:143-159`. A pid
     that is alive but has a mismatched start time counts as **dead** (pid reuse).
     A start time that cannot be read counts as **alive**.
   - the process group still has members: `process.kill(-childPgid, 0)` succeeds,
     or fails with `EPERM`. This catches leftover grandchildren of `sh -c`.

   To make the group check meaningful, both script spawns gain `detached: true`.
   The child then leads its own process group (`pgid === pid`), and timeout
   handling changes from "signal the child" to "SIGTERM the group, then SIGKILL
   the group after 10 s". The `detached` child is **not** `unref()`'d. The server
   still waits for it and collects its output as it does today. **The session
   probe is never used for script holders.**
3. **Script settle ordering**: when the `execFile` callback fires, the scheduler
   checks the group (rule 2, second bullet) before releasing. If members remain,
   it SIGTERMs/SIGKILLs the group and releases only once the group probe reports
   `ESRCH`. If the group survives SIGKILL for 30 s (uninterruptible I/O), the lock
   is kept and an attention item is raised. It is not released.
4. **Phase `starting`** (spawn not yet recorded): the record belongs to the
   scheduler process. If `serverPid` is this process, the lock is alive while
   `heldWriteLocks` has the `runId`. If `serverPid` is a different process that is
   alive with a matching start time, the lock is alive. If that process is dead or
   its start time mismatches, nothing was spawned under this record (the spawn
   step writes `running` synchronously after the child exists), so the lock is
   reclaimed. This is the one case where a server restart releases a lock
   straight away.
5. **Hard ceiling** (`hardCeilingAt = acquiredAt + 2 × run timeout + 10 min`):
   passing the ceiling is **not** a reason to release. The scheduler terminates
   the holder (session: `killSession`; script: the group kill from rule 3),
   confirms it is dead using rules 1–2, and only then releases. A holder that
   cannot be confirmed dead keeps the lock, and an attention item is raised. A
   stuck lock costs freshness. A wrongly released lock costs data, which is the
   loss this spec exists to prevent.

The reconciler runs on the scheduler's existing monitor cadence and at boot. It is
the only code that applies these rules to records this process does not hold in
`heldWriteLocks`.

### 4.6 Crash recovery

At scheduler start, before cron tasks are armed:

1. Read every record in `write-locks/`. A record that is unparsable or has the
   wrong version is **kept** and reported as a load problem, not deleted. The
   operator clears it through the route in §4.7.
2. `hostname !== os.hostname()`: never probe, never reclaim. Report a
   foreign-holder problem. The directory is meant to be host-local. If state is
   ever synced between machines, a foreign record must fail loud. This is the same
   stance `SingleInstanceLock` takes.
3. Apply §4.5. Holders that are still alive are **adopted**:
   - `session` holders: the tmux session survived the restart. The record is put
     into `heldWriteLocks` under its `runId`, so the normal `notifyJobComplete`
     path releases it.
   - `script` holders whose process group outlived the old server: the new server
     is not their parent and gets no callback. They are put in an `adoptedScripts`
     set, and the reconciler releases them when rule 2 reports dead. The run's
     history row is already handled by the existing interrupted-run recovery; this
     spec doesn't change it.
4. Dead holders are reclaimed, and a `write_lock_reclaimed` event is recorded
   with the holder record and the rule that applied.

### 4.7 Visibility and operator control

- `GET /jobs/write-locks`: an authenticated, read-only route that lists held
  locks, queued waiters and the last 20 reclaim events.
- `DELETE /jobs/write-locks/:resourceKey?runId=...`: an authenticated, local
  operator escape hatch. It refuses if the holder probes alive, unless
  `force=true`, and `force` is recorded as an event.
- Dashboard: none in this change.

### 4.8 Interop with body-level cooperative locks

The runner sets `INSTAR_HELD_WRITE_LOCKS=<comma-separated canonical paths>` in the
job's environment for sessions and scripts. Bodies that already take a
cooperative lock can treat a path in that list as already held by their own run
and skip acquiring it, which avoids deadlocking against their own runner. If a
body ignores the variable, nothing breaks, as long as its cooperative lock is a
different mechanism from this store (it is today). Writers that are not jobs,
such as interactive sessions, are not covered (§8).

### 4.9 Kill switch

`scheduler.writeResourceLocks: true | false` (default **true**). With `false`,
declarations are still validated and shown in `GET /jobs/write-locks`, but they
are not enforced. This is for rollback only.

## 5. Why runner enforcement and not the alternatives

- **Patch builtin bodies to call the cooperative lock.** It is reverted on update,
  and it leaves coverage below 100% for any user job that forgets the lock.
- **Fixed schedule offsets.** The evidence already shows a 12m14s overlap against
  a 10-minute margin.
- **One global lock for all memory jobs.** This is the same as declaring the
  resource, but less precise. `writes:` generalises it at no extra cost.
- **Atomic file writes in bodies.** They prevent torn files, but not lost updates.
  This is a read-modify-write race, and an atomic rename still loses the other
  job's edit.

## 6. Test plan (each test must fail on the current tree)

Unit tests (`tests/unit/scheduler/write-resource-locks.test.ts`):

1. **Cross-slug exclusion (session).** Two jobs with different slugs both declare
   `.instar/MEMORY.md`. Trigger both. The second gets `write-resource-busy` and is
   queued. It starts only after the first's `notifyJobComplete`.
2. **Cross-slug exclusion (script-runner and legacy script).** The same as 1 with
   one script-kind holder and one session waiter, and the other way round.
3. **Path aliasing.** `.instar/MEMORY.md` and `./.instar/../.instar/MEMORY.md`
   map to the same lock. A path outside the root is rejected at load.
4. **No head-of-line blocking.** The queue holds [blocked A, unrelated B]. B
   starts while A waits.
5. **Multi-resource ordering.** Jobs declaring `[x, y]` and `[y, x]` never
   deadlock. A partial acquire leaves no files behind.
6. **Stale release cannot free a newer run.** A late release with an old `runId`
   leaves the new holder's file in place.

Liveness and crash recovery (the cases the previous review asked for). Use
injected `pidAlive` / `pidStartedAt` / group-probe / session-probe fakes:

7. **A running script keeps its lock across monitor ticks.** Script holder, child
   alive with matching start time, `isSessionAliveAsync` returning *dead* for
   everything. Run 5 reconcile ticks. The lock is still held. (This is the
   regression case for the rule-6 finding.)
8. **A running script keeps its lock across a server restart.** Write a `running`
   script record whose `serverPid` is dead and whose child is alive. Boot a fresh
   scheduler. The lock is adopted, not reclaimed, and the waiter stays queued.
9. **Terminated script: lock reclaimed.** The same record with the child and group
   both dead (`ESRCH`). Boot or tick reclaims it, and a `write_lock_reclaimed`
   event names rule 2.
10. **Pid reuse.** The child pid is alive, but its start time differs by more than
    `PID_START_MISMATCH_MS` and the group is dead. The lock is reclaimed.
11. **Leftover grandchild.** The direct child exited and its callback fired, but
    the group probe still reports members. The lock is not released until the
    group kill completes and the probe reports `ESRCH`.
12. **Unreadable probes keep the lock.** The start time cannot be read, or the
    session probe returns `unknown`. The lock is held.
13. **`starting` record from a dead server** is reclaimed. A `starting` record from
    this live server with an in-memory entry is kept.
14. **Session holder survives a restart.** Write a `session` record whose tmux
    session is alive and boot a fresh scheduler. The lock is adopted and later
    released by `notifyJobComplete`.
15. **Hard ceiling.** Past `hardCeilingAt` with the holder still alive: the kill
    path is invoked, and the lock is released only after the confirm-dead probe.
    If the kill cannot be confirmed, the lock is kept and an attention item is
    raised.
16. **Foreign hostname** records are never probed or reclaimed.

Regeneration:

17. **Survives builtin regeneration.** Run `InstallBuiltinJobs` twice, including
    with an existing manifest whose `writes` was stripped. The rebuilt manifest
    carries the template's `writes`. `scheduler.extraWrites` is unioned in and
    cannot remove a declared resource.
18. **Template lint.** Every `src/scaffold/templates/jobs/instar/*.md` whose body
    instructs writing `MEMORY.md`, or lists it under
    `conditionalEffects`/`declaredEffects`, declares it under `writes:`.

Integration (`tests/integration/write-resource-locks.test.ts`): two real
`node -e` scripts under `runner: script` fixtures, both doing a slow
read-sleep-append on a temp `MEMORY.md`. With the fix, both appends survive. With
`writeResourceLocks: false`, one is lost. This is the reproduction from the brief,
done in-process.

## 7. Rollout

1. Loader field, validation and manifest carry-through (tests 3, 17).
2. Lock store, liveness and reconciler with injected probes (tests 6–16).
3. Wire acquire/release into the three dispatch paths and switch the script spawns
   to `detached` with group kill (tests 1, 2, 11, integration).
4. Queue scan change (test 4).
5. Template `writes:` declarations, the lint (test 18) and the read-only route.

Default on. The kill switch in §4.9 is the rollback.

## 8. Non-goals and open questions

- **Same-slug `processQueue` gap** (drain without re-checking the per-slug
  already-running guard). This is a separate item.
- **Writers that are not jobs** (interactive sessions, hooks editing
  `MEMORY.md`). They are not coordinated here. A later step could add a
  write-acquire route that uses the same store.
- **Cross-machine contention.** The store is host-local. Multi-machine agents
  serialise per slug through claims, but two different slugs on two machines
  editing a synced file are not covered. That needs a fenced lease, and it should
  only be designed once a report shows it happening.
- **Open:** does `overseer-learning` actually write `MEMORY.md` from its shipped
  prompt? (§2, evidence gap.) It is declared conservatively either way.
- **Open:** should `reflection-scan`-style user jobs that already take a
  cooperative lock be prompted, through a load-time hint, to declare `writes:` as
  well? This spec recommends a hint, not a hard requirement.
