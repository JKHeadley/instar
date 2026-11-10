---
title: Runner-enforced write resources — jobs that rewrite the same workspace file run one at a time
slug: feedback-feedback-fe4ac7f4-2095-47c7-9a49-056adb036554
status: draft
author: echo
initiative: feedback-fe4ac7f4-2095-47c7-9a49-056adb036554
cluster: cluster-builtin-job-bodies-that-write-shared-workspace-files-need-a
severity: critical
related:
  - docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md
  - docs/specs/BUILTIN-JOB-MANIFEST-FIELDS-FIX.md
  - docs/specs/job-cost-reduction.md
---

# Runner-enforced write resources

## 1. Problem

Several scheduled jobs read, modify and rewrite the same shared workspace file,
most notably `.instar/MEMORY.md`. Nothing in the scheduler stops two *different*
jobs from doing that at the same time. When their read-modify-write windows
overlap, the job that writes last silently discards the other job's changes.

The only protection now available is a cooperative lock that each job body
must remember to take. That approach has two structural flaws:

1. **Builtin bodies cannot be changed durably by the operator.**
   `InstallBuiltinJobs` (`src/scheduler/InstallBuiltinJobs.ts:181-295`) rebuilds
   every builtin manifest and body from the shipped `.md` template on each
   update. It keeps only `enabled` and `disabledAtBodyHash`. A local body edit
   that adds a lock call is reverted at the next update. A user-origin job with
   the same slug cannot replace the builtin either, because
   `AgentMdJobLoader` resolves same-slug collisions in favour of
   `origin: instar` (`src/scheduler/AgentMdJobLoader.ts:990-1004`).
2. **A cooperative lock with partial coverage gives no protection for any pair
   that includes a non-participant.** If job A takes the lock and job B never
   asks for it, A's acquire succeeds while B is writing. A believes it is
   alone at exactly the moment it is not. Coverage below 100% does not reduce
   the risk in proportion. It removes protection for every pair that includes
   a non-participant.

The existing per-slug guard in `triggerJob`
(`src/scheduler/JobScheduler.ts:1174-1196`, "a live session already holds this
slug") only stops the *same* slug from running twice. It cannot see two
different slugs contending for one file.

## 2. Evidence

Source: one reporter-written report (scrubbed, treated as untrusted data),
received 2026-08-29. The cluster's evidence file shows no truncation for that
report. The triage notes that some related reports were cut, so we don't know
how often this happens across installs.

Reported facts (not independently reproduced here):

- One concurrent rewrite of `MEMORY.md` dropped the index pointers to 11 memory
  files.
- In the reporter's workspace, 4 enabled jobs write `MEMORY.md`. The 2
  user-origin jobs use the cooperative lock. The 2 that don't are instar
  builtins, `insight-harvest` and `overseer-learning`.
- A local body fix to a builtin was erased about 5.5 hours later by builtin
  regeneration.
- `insight-harvest` (`0 */8`) is scheduled 10 minutes after a protected writer
  (`reflection-scan`, `50 */4`) to avoid a race. In the same workspace, two
  file-editing job runs overlapped for 12m14s, which is longer than that
  10-minute gap.
- The reporter keeps this separate from the known `processQueue` gap, where the
  queue drains to `spawnJobSession` without re-checking the per-slug guard.
  That issue is about the same slug. This one is about different slugs sharing
  a file.

Corroboration from the source tree:

- `src/scaffold/templates/jobs/instar/insight-harvest.md`: "Also update
  MEMORY.md with any patterns worth preserving long-term." It declares no
  effect and takes no lock.
- `src/scaffold/templates/jobs/instar/reflection-trigger.md` writes
  `.instar/MEMORY.md` and already lists it under `conditionalEffects`. That
  field is an audit hint, not a concurrency control.
- `src/scaffold/templates/jobs/instar/overseer-learning.md` reviews MEMORY.md
  updates. Its template needs to be checked for whether it writes the file.
- `maxParallelJobs` and `MAX_CONCURRENT_SCRIPTS = 3`
  (`JobScheduler.ts:221`) allow different jobs to run at the same time, and
  nothing serialises them by the files they write.

Reproduction (for the implementation PR's test): enable two jobs that both
rewrite `MEMORY.md`, set `maxParallelJobs >= 2`, and trigger both so their
read-modify-write windows overlap. Today both are admitted and one job's
changes are lost. After the fix, the second job is held in the queue until the
first reaches a terminal state.

## 3. Goals / non-goals

Goals
- The runner enforces mutual exclusion between jobs that declare the same
  write resource. Job bodies do not have to remember a lock call.
- The declaration lives in frontmatter, so it survives builtin regeneration and
  is covered by the signed lock-file `frontmatterHash`.
- A crashed holder, server restart or killed session never leaves a resource
  locked forever.
- Contention delays a job. It never drops a scheduled run silently.

Non-goals
- Locking against ad-hoc interactive sessions or humans editing the file. That
  is out of scope. Section 6 describes an optional HTTP endpoint so
  non-job writers can participate.
- Cross-machine coordination. Write resources are local paths, so the lock is
  per-machine. Jobs that already use a cross-machine claim keep that
  behaviour unchanged.
- Fixing the separate same-slug `processQueue` gap. It should be handled on its
  own, though the admission check in section 4.4 sits next to it and the two
  fixes could land together.

## 4. Design

### 4.1 Declaration: `writes:`

Add an optional frontmatter field to job definitions (agentmd, script and
legacy JSON):

```yaml
writes:
  - .instar/MEMORY.md
```

Rules:
- Each entry is a path relative to the project root. It is normalised with
  `path.posix.normalize`, must not be absolute, must not contain `..` after
  normalisation, and is case-folded on case-insensitive filesystems. The
  normalised string is the **resource key**.
- An entry may also be a named logical resource of the form `res:<name>`
  (`[a-z0-9-]+`) for multi-file units, for example `res:memory-index` covering
  `MEMORY.md` and the files it indexes.
- Directory prefixes are out of scope for v1: `a/` does not conflict with
  `a/b.md`. Exact key match keeps the conflict check O(1) and easy to reason
  about.
- At most 16 entries per job. Invalid entries make `validateManifest` reject
  the manifest loudly, in the same way other malformed fields are rejected.

Plumbing (all of these are required, or the field is silently inert):
- `buildPerSlugManifest` gains `writes?: string[]`.
- `InstallBuiltinJobs` carries `frontmatter.writes` the same way it carries
  `declaredEffects` and `conditionalEffects` (`InstallBuiltinJobs.ts:283-289`).
- `AgentMdJobLoader` and `JobLoader` validate the field and expose it on
  `JobDefinition`.
- `JobPortableBundle` and lease-job-definition replication pass it through.

Defaulting: if `writes` is absent, the runner also treats any
`declaredEffects`/`conditionalEffects` entry that is a workspace file path as
an implied write resource. This gives existing jobs (including user-origin
jobs that already list their effects) coverage without needing edits. An
explicit `writes: []` opts out.

### 4.2 Builtin template changes

Shipped templates that rewrite shared workspace files declare the resource:

| Template | Add |
|---|---|
| `insight-harvest.md` | `writes: [.instar/MEMORY.md]` |
| `reflection-trigger.md` | `writes: [.instar/MEMORY.md]` (already implied by `conditionalEffects`) |
| `overseer-learning.md` | `writes: [.instar/MEMORY.md]` **if** its body writes the file (to verify during implementation) |
| any other template that edits `MEMORY.md`, `CLAUDE.md`, `AGENT.md` or the memory index | the matching key |

The implementation PR includes a lint test. It scans every template under
`src/scaffold/templates/jobs/instar/` for body text that instructs a write to a
known shared file (`MEMORY.md`, `CLAUDE.md`, `AGENT.md`) and fails if that
template's frontmatter does not declare the file. This stops the next builtin
from reopening the gap.

The release lock-file must be regenerated, because `frontmatterHash` changes.

### 4.3 Lock store

A new module, `src/scheduler/JobWriteResourceLocks.ts`, owns an on-disk table
at `.instar/state/job-write-locks.json`:

```json
{ "version": 1,
  "holders": {
    ".instar/MEMORY.md": {
      "slug": "insight-harvest", "runId": "…", "sessionName": "job-insight-harvest-…",
      "pid": 12345, "serverBootId": "…", "acquiredAt": "ISO", "leaseUntil": "ISO" } } }
```

- Each write goes to a temp file, is fsynced, then renamed, matching the
  pattern in `AgentMdAtomicSave`. All mutations happen inside the scheduler's
  single-threaded admission path, so in-process races are ruled out. The file
  exists so the locks survive a restart. It is not a cross-process mutex.
- **All-or-nothing acquisition.** A job acquires every key it declares, or
  none of them. Keys are checked in sorted order, so partial holds and
  lock-order deadlocks cannot happen.
- **Lease.** `leaseUntil = acquiredAt + max(2 × expectedDurationMinutes,
  job timeout, 15 min)`. A live holder's lease is renewed on the scheduler's
  existing session-monitor tick.

### 4.4 Admission (queue behaviour)

The scheduler checks for conflicts at the single admission point shared by
`triggerJob` and `processQueue`. That is the same place as the per-slug
"already-running" guard (`JobScheduler.ts:1174`), so queued drains are also
covered:

1. Compute the job's resource keys.
2. If any key is held by a **different** live run, do not spawn:
   - record `skipLedger.recordSkip(slug, 'write-resource-busy')`;
   - append a `job_deferred` event that names the key and the holder slug;
   - `enqueue(slug, reason)`, where duplicate suppression already exists
     (`JobScheduler.ts:1802-1819`), and return `'queued'`.
3. Otherwise, acquire all keys for this run, then spawn. The keys are acquired
   **before** `spawnJobSession`/`runScriptJob`, so the body never starts
   without them.
4. `processQueue` skips over (does not stop at) a head-of-queue entry that is
   blocked only by a resource conflict. It then admits the next eligible job,
   so one busy file cannot hold back unrelated jobs. Blocked entries keep
   their queue position and priority ordering.
5. Starvation bound: if an entry has been deferred for a write resource for
   longer than `3 × holder.expectedDurationMinutes` (minimum 30 min), it gets a
   `job_anomaly` event (surfaced through the existing anomaly pusher). It is
   never dropped.
6. Cron ticks that arrive while the same slug is already queued are merged by
   the existing de-duplication, so a long-held resource cannot pile up
   repeated runs.

### 4.5 Release

Keys are released on every terminal path for the run, in one
`releaseFor(runId)` call:
- `notifyJobComplete` (success, failure, declared failure, killed/timeout),
  before the IntegrationGate/queue-drain step at `JobScheduler.ts:3435-3467`,
  so the drain can admit a waiter;
- script-job completion (`runScriptJob` exit/timeout callbacks);
- spawn failure, after acquisition but before a session exists;
- `clearQueue`/pause paths do not release, because the holders are still
  running.

`releaseFor` is idempotent and only releases keys whose holder `runId`
matches, so a late duplicate completion cannot free another run's lock.

### 4.6 Crash recovery

A holder entry is **stale** and is reclaimed when any of these is true:
- its `serverBootId` differs from the current boot **and** no live session
  named `sessionName` exists (`sessionManager.listRunningSessions()`).
  Rerouted job sessions that survive a restart keep their lock until
  `purgeDeadSessions` reconciles them;
- its session is no longer live (checked on each monitor tick);
- `leaseUntil` has passed and the session is not live.

If the lease has passed but the session **is** live, the lock is not stolen.
The run is reported as an anomaly (`write-resource-overrun`), because handing
over a file that is still being written is exactly the failure this spec
prevents.

On boot, the scheduler loads the table, removes stale holders, logs each
reclaim as a `job_write_lock_reclaimed` event, then starts the queue.

### 4.7 Observability

- `GET /jobs/write-locks` (authenticated, read-only) lists current holders and
  deferred waiters.
- Each run-history record gains `writeResources` and `writeWaitMs`.
- The dashboard job row shows "waiting on .instar/MEMORY.md (held by
  reflection-trigger)".

## 5. Rollout

1. Land the field, plumbing, store and admission check behind a config flag
   `scheduler.writeResourceLocks` (default **on** for new installs, **on** for
   existing installs after one release of shadow mode). In shadow mode the
   scheduler logs `would-defer` events without deferring, which measures real
   contention before enforcement starts.
2. Ship the builtin template declarations and the template lint test in the
   same release as enforcement.
3. Rollback: set the flag to off. Admission then skips the resource check and
   the table is ignored. No data migration is needed.

## 6. Optional follow-up: non-job participants

`POST /jobs/write-locks/acquire` / `release` (authenticated, local only, with
a lease) would let interactive sessions or hooks take the same resource keys.
This is out of scope for the first change. It is listed so the store's API
supports it later without a schema change.

## 7. Test plan (implementation PR)

- Unit: key normalisation (rejects absolute paths and `..`, folds case on
  case-insensitive filesystems); all-or-nothing acquisition; `releaseFor` only
  releases keys whose holder `runId` matches.
- Scheduler: two different slugs that declare `.instar/MEMORY.md` with
  `maxParallelJobs = 2`. The second returns `'queued'` and is admitted only
  after the first's `notifyJobComplete`. A third job with no shared key is
  admitted while the second waits, so there is no head-of-line blocking.
- Queue path: a job admitted through `processQueue` goes through the same
  resource check.
- Crash: a holder with a previous `serverBootId` and no live session is
  reclaimed on boot. A holder whose session is still live is kept.
- Regeneration: running `InstallBuiltinJobs` over a template with `writes`
  produces a manifest containing `writes`, and a second install preserves it.
- Lint: every builtin template whose body instructs a `MEMORY.md` write
  declares it.

## 8. Open questions

- Should `overseer-learning` be declared? This depends on whether its body
  actually writes `MEMORY.md` or only reads it. The template must be checked
  during implementation.
- Should directory-prefix conflicts (`.instar/memory/` vs a file inside it) be
  supported in v1, or is `res:` enough?
- The reporter's evidence covers one install. Shadow mode (section 5) should
  confirm how often contention happens before the starvation thresholds are
  tuned.
