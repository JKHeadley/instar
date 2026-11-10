---
title: "Durable job-scheduler capacity queue"
slug: "feedback-feedback-2339cf3a-51f1-4473-b9f2-466ed089e712"
author: "Echo"
status: "draft"
---

# Durable job-scheduler capacity queue

## 1. Problem

`JobScheduler` keeps work that it accepts but cannot start yet in an in-memory array (`private queue: QueuedJob[]`, `src/scheduler/JobScheduler.ts:203`). Two paths add to it:

- **The slot cap** (`triggerJob`, `:1356`). When `jobSessions + activeSessionSpawns >= maxParallelJobs`, the scheduler calls `enqueue(slug, reason)` with `capacityWait = false` and returns `'queued'`. Nothing is written to disk. No activity event and no run-history row is written either.
- **Reroute or session-capacity refusal** (`:3020`). This calls `enqueue(..., true)`. `recordCapacityWait` then writes the `job-capacity-episode` state key and a `job_waited_for_room` event, and `start()` re-enqueues these jobs as `capacity-recovery` (`:850`).

Only the second kind of wait survives a restart. A slot-cap wait is lost in three cases:

1. The process exits. The array goes with it.
2. `stop()` runs. It sets `this.queue = []` (`:924`).
3. The queue already holds 50 entries. `enqueue` drops the new one with only a `console.warn` (`:1814`).

After any of these, the job's run history shows nothing for that occurrence. The startup missed-job check (`checkMissedJobs`, `:4273`) only catches up a job whose last run is more than 1.5× its interval old. For a daily job that means about 36 h, so an occurrence lost in a restart is usually not recovered. Nothing records that it ever existed.

`processQueue` also loses work: it `shift()`s the entry from memory before the asynchronous `triggerJob` finishes (`:1473`). A crash in that window loses the entry.

## 2. Evidence

The evidence file holds one report, received 2026-11-02. The cluster is marked incomplete. The report's main claim is backed by code, and its timeline is the reporter's account:

- On 2026-11-01, two job sessions held both slots (`maxParallelJobs: 2`) for about 10 h. Five daily jobs came due in that window and never ran: overseer-infrastructure, overseer-development, correction-class-review-backstop, relationship-maintenance and rope-health-digest.
- The server restarted at 19:02Z and 19:39Z, before the 22:28Z kill.
- The drain after the kill wrote `queued:missed` rows for the frequent jobs health-check and issue-triage-poll. It wrote none for the daily jobs, which are under the 1.5× catch-up floor.
- The reporter says plainly that the restart losing the entries is **inferred**, because nothing records what the queue held. The code above confirms that such a loss is possible and leaves no record. The missing record is part of what the report asks to fix.
- Asks: (1) keep the queue across a restart, or log each entry that is thrown away; (2) write a history row when a job is queued because of the cap.
- Out of scope: the age-limit deferral that kept the two sessions alive. Other reports already cover it.

## 3. Lessons from the previous attempt (PR #2985)

The independent review rejected the earlier draft for two reasons. This design addresses both directly:

- **R1. Accepted work fell back to memory when persistence failed.** That brought the original bug back. Here, the scheduler accepts work **only after the durable write succeeds**. If the write fails, it refuses the work and tells the caller (§4.3). The scheduler never answers `'queued'` for work that exists only in memory.
- **R2. A new occurrence inherited the old entry's age.** When a later fire replaced a queued entry, the entry kept its original `queuedAt`, and expiry was measured from that. A fresh occurrence could therefore expire immediately. Here, each entry has separate occurrence timestamps and a separate continuous-wait timestamp. Expiry reads only the occurrence timestamps. Replacing an entry resets them (§4.5).

Also unlike the earlier draft, this design does **not** merge `job-capacity-episode` into the new record. The episode key keeps its job as alert state, which keeps the change smaller.

## 4. Proposed design

### 4.1 Durable record

Add a new state key, `job-queue`. It is written through `StateManager.set`, which already does atomic temp-file-and-rename writes:

```ts
interface PersistedJobQueue {
  version: 1;
  machineId: string | null;
  entries: PersistedQueueEntry[];
}
interface PersistedQueueEntry {
  entryId: string;              // stable id, unique per accepted occurrence
  slug: string;
  reason: string;               // original trigger reason ('scheduled', 'missed', ...)
  cause: 'max-parallel' | 'reroute-capacity';
  capacityWait: boolean;
  occurrenceDueAt: string;      // when this occurrence was due (cron fire time / trigger time)
  occurrenceAcceptedAt: string; // when this occurrence was durably accepted
  firstQueuedAt: string;        // start of the continuous wait for this slug (visibility only)
  supersededCount: number;
  admittingAt?: string;         // set while processQueue is handing the entry to triggerJob
}
```

The durable record is the source of truth. The in-memory `queue` becomes a cache of it, and every change to the cache goes through one helper, `commitQueue(next)`. That helper writes the record first and updates memory only if the write succeeds.

### 4.2 Enqueue becomes accept-or-refuse

`enqueue` returns `'accepted' | 'coalesced' | 'refused'`:

1. **Same slug already queued.** The scheduler coalesces the two (§4.5). One slug never has two entries, which is the same dedupe rule as today.
2. **Queue at 50 entries.** The scheduler refuses the work and records it as a terminal outcome, `queue-full` (§4.4). This replaces the bare `console.warn`.
3. **Otherwise.** The scheduler builds the next array and calls `commitQueue`. When that succeeds, it appends a `job_queued` activity event with `{ slug, reason, cause, occurrenceDueAt, queueDepth, entryId }`. This is ask (2). It then calls `recordCapacityWait` when `capacityWait` is set, as it does now.

`triggerJob` returns `'queued'` only when the result is `'accepted'` or `'coalesced'`. A `'refused'` result returns `'skipped'`, and the refusal is recorded as described below.

### 4.3 Persistence failure (fixes R1)

`commitQueue` can throw, for example on disk errors or when `guardWrite` refuses on a read-only standby. When it does:

- The in-memory queue stays unchanged, so nothing that exists only in memory is ever treated as accepted.
- `enqueue` returns `'refused'`, so the caller, `triggerJob`, returns `'skipped'`. The cron fire, the missed-job sweep and the HTTP trigger route all see a non-queued result.
- The scheduler makes a best-effort record of the refusal:
  - a `skipLedger.recordSkip(slug, 'capacity')` entry;
  - a `job_queue_refused` event whose metadata includes `error`;
  - a `DegradationReporter` report.

  These may also fail if the disk is gone. They are not acceptance, so failing to write them does not hide accepted work.
- `JobState.lastRun` is not touched, so the job's normal schedule keeps working.

A read-only standby does not accept queued work. That is correct: the lease holder owns execution.

### 4.4 Terminal outcomes in run history

Add `JobRunHistory.recordQueueOutcome({ slug, trigger, entryId, outcome, queuedAt, detail })`. It writes one completed row with `result: 'skipped'`, `durationSeconds: 0` and a new optional field, `queueOutcome`. `skipped` rows are already left out of success and failure stats (`JobRunHistory.ts:443`), so these rows do not count as runs.

The possible `queueOutcome` values are:

| outcome | when |
|---|---|
| `queue-superseded` | a later occurrence of the same job replaced this one (§4.5) |
| `queue-expired` | the occurrence passed its expiry ceiling (§4.6) |
| `queue-already-ran` | on recovery, the job's `lastRun` is at or after `occurrenceDueAt`, or the admitting run is found (§4.7) |
| `queue-job-removed` | the job is missing, disabled, or no longer scoped to this machine |
| `queue-full` | the queue was full when the occurrence arrived |
| `queue-cleared` | an operator called `clearQueue()` |
| `queue-refused-unpersisted` | the acceptance write failed (§4.3); best effort |

An entry that does run gets no outcome row. Instead, its run row gains a `queuedAt` field set to `firstQueuedAt` (the `trigger` stays `queued:<reason>`), so the job's history shows the wait. Every accepted occurrence ends either as a run row or as one of the outcome rows above. The existing `job_skipped` events in `processQueue` stay.

### 4.5 Coalescing and supersession (fixes R2)

Suppose an occurrence arrives while the same slug is already queued. For example, the next daily cron fire arrives while yesterday's occurrence is still waiting:

- The scheduler writes a `queue-superseded` row for the **old** occurrence.
- It sets `occurrenceDueAt` and `occurrenceAcceptedAt` to the **new** occurrence's values and increments `supersededCount`. It keeps `firstQueuedAt`, which is used only for display and capacity alerts.
- A `capacityWait` refusal upgrades `capacityWait`, as `enqueue` already does.
- It writes the change through `commitQueue`. If that write fails, the old entry stays valid and durable. The new occurrence gets `queue-refused-unpersisted`, and the caller sees `'skipped'`.

If a non-cron trigger, such as `missed` or `capacity-recovery`, arrives for a slug that is already queued, nothing is superseded. It is the same pending work, so the scheduler returns `'coalesced'` and keeps the existing occurrence timestamps.

### 4.6 Expiry

An entry expires when `now - occurrenceDueAt > ceiling(job)`. Here `ceiling(job) = clamp(1.5 × cronInterval(job), 1 h, 7 d)`, where `cronInterval` is computed the same way as in `checkMissedJobs`. Neither the continuous wait time nor `firstQueuedAt` takes part in expiry.

The scheduler checks expiry in two places: during recovery at `start()`, and in `processQueue` just before admission. An expired entry gets a `queue-expired` row and leaves the record. From then on, the normal cron schedule and `checkMissedJobs` handle the job.

In the reported incident, the daily jobs were within a 36 h ceiling, so this design would recover them and run them.

### 4.7 Admission without loss or duplicates

`processQueue` no longer `shift()`s before admission:

1. It sets `admittingAt` on the head entry through `commitQueue`. If that write fails, it does not admit the entry this tick.
2. It calls `triggerJob(slug, 'queued:<reason>')`. The entry leaves the record once the result is final:
   - `'triggered'`: the run row exists (`recordStart`), so the entry is removed.
   - `'skipped'` with a recorded reason: the matching outcome row is written and the entry is removed.
   - Re-queued: for example, a reroute refusal re-enters through `enqueue` and coalesces, and `admittingAt` is cleared.

   The other ways an entry leaves the queue today follow the same rule. These are `markCapacityJobStarted`, a job that is disabled or missing, and the script-supervision skip. Each removes the entry through `commitQueue` and writes the matching outcome row.
3. On restart, an entry that still has `admittingAt` might already have started. Recovery checks run history for a run of that slug with `startedAt >= admittingAt`, and checks `JobState.lastRun >= occurrenceDueAt`.
   - If either check finds a run: write `queue-already-ran` and drop the entry. This prevents a duplicate.
   - If neither does: clear `admittingAt` and keep the entry.

   The existing machine claim (`takeClaim`) remains the second guard against running the job twice.

### 4.8 Restart recovery

In `start()`, before `checkMissedJobs` is scheduled and next to the existing episode recovery:

1. **Load `job-queue`.** If the file is missing, start with an empty record.
2. **If the file is corrupt or has an unknown version:**
   - copy the file aside as `job-queue.corrupt-<ts>.json`;
   - report through `DegradationReporter`;
   - append a `job_queue_unreadable` event;
   - start with an empty record.

   The original file is never deleted silently.
3. **Recover entries.** Skip entries whose `machineId` belongs to another machine. Classify each remaining entry with §4.6 and §4.7 and the job-removed rule. Load the survivors into memory **without a fresh acceptance write**, since they are already durable. Append one `job_queue_recovered` event that lists the slugs.
4. **Reconcile the episode.** `job-capacity-episode` recovery stays. Its `capacity-recovery` enqueue coalesces with any recovered entry.
5. **Arm the queue poll.** If the record has entries, start the existing 15 s poll. Today it is armed only for capacity waits. Generalise it so slot-cap entries also drain after a restart, even before any session ends.

`checkMissedJobs` then runs. If it finds a slug that is already queued, it coalesces with that entry and does not add a second one.

### 4.9 `stop()` and `clearQueue()`

- `stop()` clears only the in-memory cache. The durable record is left alone so the next `start()` recovers it.
- `clearQueue()` is the operator's explicit discard. It writes a `queue-cleared` row for each entry, then commits an empty record, then clears the episode as it does now.

### 4.10 Visibility

`getQueue()` and `/jobs` (`routes.ts:19091`) return the persisted fields, including `firstQueuedAt`, `occurrenceDueAt` and `cause`, so an operator can read the queue directly.

## 5. Regression tests

The tests go in a new file, `tests/unit/scheduler/JobScheduler.durable-queue.test.ts`. They use a temp `stateDir`, a stub `sessionManager` whose running sessions fill `maxParallelJobs`, and fake timers.

1. **Restart keeps slot-cap work.** `triggerJob` returns `'queued'`, and `job-queue.json` contains the entry. A new scheduler starts on the same `stateDir`. When the slot is freed and the poll runs, the job triggers with `queued:scheduled`, and the run row has `queuedAt` set. *(This test fails on current code.)*
2. **Enqueue is visible.** A `job_queued` event with `cause: 'max-parallel'` is appended. *(Fails today.)*
3. **Persistence failure is refused, never memory-only (R1).** Stub `state.set('job-queue')` to throw. `triggerJob` returns `'skipped'`, `getQueue()` is empty, a `job_queue_refused` event or skip-ledger entry exists, and a restarted scheduler shows nothing claimed as accepted. A second case covers a failed write while coalescing: the old entry stays durable and still recovers.
4. **A replacement occurrence does not inherit the old age (R2).**
   - Queue at T0 and advance to just before T0's ceiling.
   - Fire a fresh occurrence at T1, which supersedes the T0 occurrence.
   - Advance past T0's ceiling but not T1's, then restart.
   - Expected: the entry is recovered and runs. A `queue-superseded` row exists for the T0 occurrence. No `queue-expired` row exists.
5. **Expiry is a recorded terminal outcome.** An entry older than its ceiling at restart gets a `queue-expired` row and does not run.
6. **No loss or duplicate across a crash during admission.**
   - With `admittingAt` set and a matching run row: recovery writes `queue-already-ran`, and the job does not trigger again.
   - With `admittingAt` set and no run row: the entry is re-queued and runs once.
7. **A full queue is recorded.** The 51st distinct slug gets a `queue-full` row.
8. **`stop()` keeps the record, and `clearQueue()` records the discard.**
9. **A corrupt record is set aside, not silently reset.**
10. **Missed-job catch-up coalesces with a recovered entry**, so only one run happens.

## 6. Compatibility and rollout

- **No migration.** A missing `job-queue` key means an empty queue. Entries created by the existing `job-capacity-episode` recovery flow into the new record through `enqueue`.
- **Additive changes:**
  - `JobRun` gains the optional fields `queueOutcome` and `queuedAt`;
  - `SkipReason` gains no new value, because `'capacity'` is reused;
  - there are four new activity event types: `job_queued`, `job_queue_refused`, `job_queue_recovered` and `job_queue_unreadable`.
- **Rollback.** Older builds ignore the extra state key and run-history fields.
- **Write volume.** There is one small atomic write per enqueue, coalesce, admission and removal. The queue holds at most 50 entries.

## 7. Out of scope

- The age-limit deferral that kept the sessions alive. Other reports cover it.
- Changing the 1.5× missed-job floor itself.
- Moving queued work to another machine.
