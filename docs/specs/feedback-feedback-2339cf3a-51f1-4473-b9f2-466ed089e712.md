---
title: "Durable over-cap job queue: queued work survives restart or ends in a recorded outcome"
slug: "feedback-feedback-2339cf3a-51f1-4473-b9f2-466ed089e712"
author: "echo"
parent-principle: "Never Silently Cut the Data"
feedback-initiative: "feedback-2339cf3a-51f1-4473-b9f2-466ed089e712"
feedback-cluster: "cluster-job-scheduler-s-over-cap-queue-is-memory-only-a-restart-can"
component: "src/scheduler/JobScheduler.ts (capacity queue)"
severity: "critical"
---

# Durable over-cap job queue

## 1. Problem

When every job slot is taken (`maxParallelJobs`), `JobScheduler.triggerJob()` puts
the due job in an in-memory queue and returns `'queued'`
(`src/scheduler/JobScheduler.ts:1348-1350`). That queue:

1. **Lives only in memory.** `private queue: QueuedJob[] = []` (`:195`). `stop()`
   empties it (`:916`) and nothing writes it to disk or reads it back.
2. **Leaves no record.** `enqueue()` (`:1794-1819`) writes no event, no
   run-history row and no skip-ledger entry when `capacityWait` is false. The
   job's history shows nothing between "not run" and "queued and waiting".
3. **Drops work without a trace when full.** If the queue already has 50 items
   (`:1806-1809`), the new entry is dropped with only a `console.warn`.

The scheduler already has a narrower, durable path for a *different* kind of
wait. When a spawn is refused for reroute or session capacity
(`RerouteRefusedError` / `SessionCapacityRefusedError`, `:3009-3012`), it calls
`enqueue(slug, reason, true)`. That path writes the `job-capacity-episode` state
key and a `job_waited_for_room` event (`recordCapacityWait`, `:1822-1840`).
`start()` reads the key back and re-queues those jobs as `capacity-recovery`
(`:842-849`). The common case, where all slots are held by running job
sessions, never goes through this path.

### Why the missed-job sweep does not cover it

On restart, `checkMissedJobs()` (`:4114+`) only fires a job when
`now - lastRun > 1.5 × interval`. A daily job due at 09:00 whose previous run
was at 09:00 the day before is about 34h stale at a 19:00 restart, which is
under the 36h floor. So the sweep skips it. That day's cron fire has already
happened (and went into the queue that was lost), so the job does not run
until the next day, and nothing records that the occurrence was missed.
Frequent jobs (such as `health-check`) do pass the floor, which is why the
reporter saw `queued:missed` rows for those jobs and none for the daily jobs.

## 2. Evidence

One report (`.feedback-evidence.json`, received 2026-11-02). The triage marked
the evidence incomplete. The reporter says the key step is inferred, not
observed:

- On 2026-11-01 two job sessions held both slots (`maxParallelJobs: 2`) for
  about 10 hours.
- Five daily jobs were due in that window and did not run:
  `overseer-infrastructure`, `overseer-development`,
  `correction-class-review-backstop`, `relationship-maintenance` and
  `rope-health-digest`.
- The server restarted at 19:02Z and 19:39Z, before the sessions were killed
  at 22:28Z.
- The drain after the kill wrote `queued:missed` rows only for `health-check`
  and `issue-triage-poll`.
- **Inferred, not observed:** that the restarts threw away the queued
  entries. Nothing records what the queue held, so this cannot be confirmed
  after the fact. The missing record is part of the defect.

Reading the code confirms every step of the inferred mechanism (§1). The
report's two asks are: (1) persist the queue across restart, or write a row
naming each entry that was thrown away; (2) write an activity row when the cap
queues a job.

Out of scope: the age-limit deferral that kept the two sessions alive
(already reported as fb-2c4eefaa-cc0).

## 3. Proposed fix

### 3.1 One durable queue record for every queued entry

Replace the separate in-memory `queue` and `job-capacity-episode` with a
single persisted queue held in `StateManager` under a new key,
`job-queue` (version 2):

```ts
interface PersistedQueuedJob {
  slug: string;
  reason: string;            // original trigger reason ('scheduled', 'missed', ...)
  queuedAt: string;          // first time this occurrence was accepted
  dueAt: string;             // the cron occurrence it stands for (scheduled) or queuedAt
  kind: 'slot-cap' | 'reroute-capacity';
  attempts: number;          // admission attempts that ended back in the queue
}
interface PersistedQueue { version: 2; entries: PersistedQueuedJob[]; }
```

- `enqueue()` writes the record before it returns. In-memory state is a cache
  of the record and is never the only copy. If the write fails, log the error
  and still queue in memory: a lost record is no worse than today's
  behaviour, and refusing the job would be worse.
- Every way an entry leaves the queue writes the record: started,
  skipped, expired, superseded, cleared or dropped.
- `stop()` empties the in-memory cache and **leaves the record alone**.
- Migration: on first start after upgrade, read an existing version-1
  `job-capacity-episode` into entries with `kind: 'reroute-capacity'`. Keep
  the episode alert fields (`firstBlockedAt`, `blockedAtByJob`, `alertedAt`,
  `recordedAt`), derived from the entries, so `maybeAlertCapacityEpisode()`
  works the same as before. Alerting stays limited to `reroute-capacity`
  entries. Slot-cap waits get the history row below and no new alert.

### 3.2 A history row for every queue change

Add one event type, `job_queued`, and a matching terminal event
`job_dequeued`. Each carries
`metadata: { slug, reason, kind, queuedAt, dueAt, outcome }`, where `outcome`
is one of `started | skipped:<gateReason> | expired | superseded | cleared |
dropped-queue-full | restored | discarded-on-restore:<why>`.

- Record a `capacity` skip in the skip ledger when an entry is queued
  (`SkipReason` already defines `'capacity'` as "queued instead of skipped, but
  tracked", but nothing records it today).
- Queue full (`>= 50`): write `job_dequeued` with
  `outcome: 'dropped-queue-full'` and record a skip. Do not drop silently.

### 3.3 Restart recovery

In `start()`, after `refreshJobs()` and before `checkMissedJobs()`:

1. Load `job-queue`. If the record is unreadable or malformed, write one
   `scheduler_queue_restore_failed` event that includes the raw entry count
   if it can be read, then continue with an empty queue. Never throw out of
   `start()`.
2. For each entry, apply the checks in this order and write a `job_dequeued`
   row for each discard:
   - job no longer exists or is disabled → `discarded-on-restore:disabled`
   - job not scoped to this machine → `discarded-on-restore:machine-scope`
   - expired (§3.4) → `expired`
   - job has already run since `dueAt` (`jobState.lastRun >= dueAt`, for
     example on another machine or by a manual trigger) → `superseded`
   - otherwise re-queue it in memory with its original `queuedAt`/`dueAt`
     and write `job_queued` with `outcome: 'restored'`.
3. Restored slugs are excluded from the `checkMissedJobs()` pass of the same
   boot, so one occurrence cannot fire twice.

### 3.4 Expiry

An entry stands for one cron occurrence and becomes stale once the next
occurrence is due. At admission (in `processQueue()`) and on restore, an
entry expires when the job's *next-after-`dueAt`* cron occurrence has
already passed and a newer fire has been accepted or queued for the same
slug. The newer occurrence replaces it (`superseded`). Separately, there is a
hard ceiling: an entry older than `max(2 × interval, 1h)` (interval taken
from the cron task's `nextRuns(2)`) expires with `outcome: 'expired'`, so
stale work does not fire hours late. Jobs whose `catchUpPolicy` is `skip`
expire at the first restart instead of being restored.

### 3.5 Duplicate prevention

- One entry per slug (unchanged from today). A later fire for a queued slug
  updates `dueAt` to the newer occurrence and writes `superseded` for the old
  one. It never adds a second entry.
- Admission still goes through `triggerJob(slug, 'queued:<reason>')`, which
  takes the machine claim (`takeClaim`) and runs the per-slug
  `already-running` guard, so a restored entry cannot double-run against a
  live session or another machine.
- The entry is removed from the record (`outcome: 'started'`) only after
  `triggerJob` returns `'triggered'`. If it returns `'skipped'`, the entry is
  removed with `skipped:<gateReason>`, except for `reroute-capacity` entries,
  which go back into the queue as they do today (`:1520-1528`).
- A crash between spawn and record removal leaves an entry whose job has
  `lastRun >= dueAt`. The `superseded` check in §3.3 discards it on the next
  start.

### 3.6 Observability

- `getStatus()` / `GET /jobs/queue` report each entry's `kind`, `queuedAt`
  and `dueAt`.
- The reporter's own rule ("all slots held for a long time by sessions that
  the age limit will not reap") remains agent-side and is out of scope here.

## 4. Tests (to be written with the implementation)

In `tests/unit/scheduler-queue-edge.test.ts` / `job-capacity-episode.test.ts`:

1. **Slot-cap entry survives restart.** Fill slots → trigger a daily job →
   `stop()` → new scheduler on the same state dir → `start()` → free slots →
   `processQueue()`. The job is triggered with reason `queued:scheduled`.
   This fails on the current code.
2. Enqueue writes a `job_queued` event and a `capacity` skip-ledger entry.
3. Queue-full drop writes `dropped-queue-full`.
4. Restore discards disabled, machine-scoped, expired and superseded entries,
   each with its own `job_dequeued` row.
5. A restored entry is not fired a second time by `checkMissedJobs()` on the
   same boot.
6. A malformed `job-queue` record does not make `start()` throw, and writes
   `scheduler_queue_restore_failed`.
7. A legacy version-1 `job-capacity-episode` migrates, and the capacity alert
   timing does not change.

## 5. Risks

- **Late firing after a long outage.** The expiry ceiling (§3.4) and
  `catchUpPolicy` bound how late a job can fire.
- **State write volume.** At most one small JSON write per queue change. The
  queue is capped at 50 entries.
- **Behaviour change for alerts.** None. Alerting stays limited to
  `reroute-capacity` entries.

## 6. Open questions for review

- Should slot-cap waits that last longer than N minutes raise an attention
  item, as reroute waits do, or is the history row enough? This draft says the
  history row is enough.
- Is `max(2 × interval, 1h)` the right expiry ceiling, or should it come from
  each job's `expectedDurationMinutes`?
