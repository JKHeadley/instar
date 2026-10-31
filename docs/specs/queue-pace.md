---
title: "Queue pace: arrivals vs completions for every work queue, and a bounded pace tuner"
slug: "queue-pace"
author: "echo"
parent-principle: "Close the Loop"
eli16-overview: "docs/specs/queue-pace.eli16.md"
review-convergence: "2026-10-31T03:43:45.172Z"
review-iterations: 6
review-completed-at: "2026-10-31T03:43:45.172Z"
review-report: "docs/specs/reports/queue-pace-convergence.md"
approved: true
approved-by: "echo under Justin's standing delegation (only constitution changes need his approval; touches no CODEOWNERS path)"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 2
contested-then-cleared: 1
---

# Queue pace

## Problem statement

Justin, 2026-10-30 20:12 (topic 128732): "We need to track the pace of progress for all items. In
fact, anything like this that regularly works on a queue such as this OR the feedback should have a
mechanism to dynamically adjust the cadence to match the pace of the queue to make sure the pace of
progress is greater than the pace of issue/item creation."

Measured the same evening on the Studio:

- Feedback: about 350 reports/day reach the canonical store; 386 work items are triaged `work`, 381
  of them `queued`. The executor started 0 that day: it allows `maxOpenPrs: 4` and all four open
  fix PRs (#2439, #2442, #2453, #2454) had **failed the independent review** (`review-failed:
  serious:codex-cli`, written on each PR) and nothing reworks or closes a failed PR, so the four
  slots stay held. (An earlier reading of these as "waiting for the owner's approval", from the
  `hold` label every executor PR carries, was wrong; that label is not a waiting reason.) Triage was
  paused at 84% account quota.
- Maturation: 89 features need attention; 23 have a linked fix.

A survey of the repo (2026-10-30) found no surface that pairs arrivals with completions for any
work queue, nothing that changes any job's pace from its backlog, and every throughput knob a fixed
ceiling. `AutoTuneState` and the `WorkloadSignal` ledger (`SkipLedger`) were laid down for adaptive
scheduling, but no feedback job records workload and the only writer is a caller-posted route
(`POST /skip-ledger/workload`), so they cannot be used as evidence. The only built backlog-growth
detector is `CartographerSweepPoller` (`staleBacklogGrowthTicks`), which reports and changes nothing.

The evening's numbers also show why "just run faster" is wrong on its own: the feedback fix queue's
limit was capacity held by rejected work, not the cadence of any job.

## Proposed design

Three pieces, each built on an existing owner. No parallel engine.

### 1. QueuePaceLedger — measure

A registry of **queue adapters**. An adapter is a pure read over one existing owner, in two parts:

- **Transition events (primary).** Each adapter reads the owner's own timestamped records with a
  durable cursor: entries (created/decided-work/entered-attention timestamps) and exits with their
  kind — `completed` (the owner's success state) or `exitedOther` (withdrawn, expired, cancelled,
  held, ignored, deleted, pruned). Every event is deduplicated by `(queue, itemId, kind, at)`, so an
  item that enters and finishes inside one hour, or leaves and returns, is still counted. Cursors are
  kept in `state/queue-pace/<queue>.cursor.json`.
- **Snapshots (reconciliation).** Each hour the adapter also returns the set of item ids currently
  open. Events and snapshot share one read boundary: the adapter takes a watermark (the newest event
  timestamp, or the owner's revision where it has one), reads the open set, then re-reads events up to
  that watermark; if any event newer than the watermark appeared during the read, it retries once and
  otherwise writes `ok:false, reason:'read-race'`. Reconciliation applies each event to the previous id
  set and compares the result with the snapshot id-by-id, not only by count. For `feedback.fix`, both
  stores (triage and execution) live in the same SQLite database (`drain.sharedDatabase()`), so the
  adapter reads both inside one read transaction. The ledger checks that `open_t = open_(t-1) + entered + reentered − completed − exitedOther`
  for the interval; if the event stream and the snapshot disagree by more than 10% of the interval's
  transitions, or ids left with no recorded exit, the interval is `ok:false, reason:'count-drift'`.

Where an owner keeps no timestamps for a transition (the triage hold→work return; evolution
pruning, which deletes the completion time; the prune's archive records the id, which classifies
the exit as `exitedOther: pruned`), the adapter declares that transition
**snapshot-derived**: counted from the id-set diff, at most once per interval, and the row is
marked `turnover: 'incomplete'` (an item that left and returned between snapshots is invisible to a
diff). Such rows count for the display verdict but not for tuner eligibility. Where the owner keeps a
transition audit (the triage store's decision rows, the executor's attempt rows) the adapter uses it
and the transition is event-sourced. `reentered` = an id that was in the queue before, left, and came back. Adapters never write to
their owner and always use the server's live store instance (never a fresh load of a multi-MB file).
The previous id set per queue is kept in `state/queue-pace/<queue>.ids.json` (ids only, bounded to
20,000; a queue over the bound records `ok:false, reason:'too-large'`).

v1 adapters (membership = the open set; success = the completion state):

| Queue id | Membership (open) | Completed | Exited other | Owner (machine) | Tunable |
|---|---|---|---|---|---|
| `feedback.triage` | work items awaiting a triage decision | given a decision (`work`/`hold`/`ignored`) | removed by the drain | FeedbackTriageStore (operated host) | **yes** |
| `feedback.fix` | items decided `work` on the FIX path whose fix PR has not merged | the fix PR `merged` (not `verified`, which trails 30 days) | re-triaged away, held, parked | triage store + executor attempt store (operated host) | no |
| `maturation.fix` | features counted in the board's `stalledRegressedBlind` for the latest review | left that count with an improved verdict | left the review, retired | review files via the MaturationBoard builder (the review machine) — stepped per review, not hourly | no |
| `commitments` | this machine's active commitments (`getActive()`) | delivered | every other terminal state, and silent expiry past `expiresAt` | this machine's own CommitmentTracker (every machine; replicated copies are never read) | no |
| `evolution` | this machine's pending + in_progress actions | completed | cancelled, auto-expired, pruned beyond `maxActions` | this machine's own evolution store (every machine) | no |

Items on the **spec path** leave `feedback.fix` membership when their spec PR opens and are shown
only as a context count ("N designs drafted, not yet built"): the build that follows a merged spec
runs outside the executor and records no link back to the item, so its completion cannot be measured
yet. They are never counted as completed.

Feedback intake (raw reports) is shown as a context number (reports/day) but is not a paced queue:
raw report counts are attacker-floodable fleet input and are clustered before they become work.

**Intervals and coverage.** Rows are written for fixed, non-overlapping hourly intervals
`[from, to)` to `logs/queue-pace.jsonl`. Coverage is measured in **elapsed time**: a row covers only
its own hour. A missed hour stays uncovered forever (never backfilled). The first row after a gap is a
`baseline` row (`ok:false, reason:'baseline'`): it takes a fresh snapshot, records whatever the
cursors recovered from the gap in a separate `gapRecovered: {from, to, entered, completed,
exitedOther}` field (context only: "while measurement was down: …"), and counts toward nothing.
Covered intervals resume at the next hour boundary. Inflow, outflow and the backlog change are always
computed over the SAME set of covered hours: `Δopen` is the sum of each covered row's own
`open_end − open_start`.
Transitions that can only be inferred from the snapshot diff are flagged `turnover: 'incomplete'`. A row with incomplete turnover counts toward coverage for display
but never toward tuner eligibility. Row fields: `{queue, from, to, open, entered, reentered, completed,
exitedOther, ok, reason?, machine}`. A failed read writes `ok:false` with a reason and no numbers,
never zeros. The first interval on a machine with no previous id set or cursor (new owner, lost
state) writes `ok:false, reason:'baseline'`, so the whole open set is never counted as arrivals. **Crash-safe commit.** Each row carries `cursorAfter` and `idsDigest` (hash of the open id set)
and is identified by `(machineId, queue, from)`; a repeated append of the same identity is ignored.
The order is: append the row (fsync), then atomically replace `state/queue-pace/<queue>.json`
(`{cursor, ids, lastFrom}`, write-temp-then-rename). On start, if the last row for a queue is newer
than the state file, the state's cursor is taken from that row's `cursorAfter`; if the ids digest then
does not match, the next interval is a `baseline` row. A crash therefore never double-counts (row
identity) and never loses events (the cursor only advances with a written row).
Retention: rows older than 14 days are compacted to daily rows and kept 90 days; the 7-day window
is read from the file tail.

**Verdict** over a 7-day window (the shorter available window is labelled), using only covered
intervals; for `maturation.fix` over the last 3 reviews instead (its membership changes only when a
review lands):

- `unknown` unless ≥ 80% of the window's intervals are `ok` and the last 3 are `ok`.
- Otherwise, with `inflow = entered + reentered`, `outflow = completed` (exits do not count as
  progress) and `Δopen` over the window:
  - `falling-behind`: `Δopen` > 5% of the window's starting open (min 1) and `inflow > outflow`.
  - `catching-up`: `Δopen` < −5% of starting open (min 1) AND `outflow > inflow`.
  - `holding`: `|Δopen|` within that 5% tolerance.
  - `shrinking-by-exits`: the backlog fell but `outflow ≤ inflow` (items left by other exits, not by
    being done). Shown plainly as "shrinking, but not by finishing work"; never counts as progress.
  - every remaining combination → `unknown` with reason `mixed-signal`.
  - `owner-not-serving` (feedback queues only; a precondition checked before every other verdict, which
    it overrides): the operated host is not currently running
    the feedback ticks (the same predicate the server uses to start them: operated host AND holding
    the serving lease AND not restore-pending). No `falling-behind` is ever
    inferred while in this state.
- Hysteresis: a new verdict must hold for 2 consecutive evaluations before it replaces the old one.
- `daysToClear` = `open / ((outflow − inflow) per day)` only when `catching-up` and that rate is
  strictly positive; otherwise `null`.
  Never shown on a queue whose bottleneck is `person`.

### 2. Bottleneck — say why

Evaluated for each `falling-behind` queue. Every kind that matched is recorded in `matched[]`. The
**winner is the reason that actually refused or stopped the worker most recently** (the latest
service-written refusal or stop row: e.g. executor admission `max-open-prs`, triage
`call-cap-reached`); only when no refusal row exists does the fixed precedence below pick among the
matched kinds. The **actionable** bottleneck uses only evidence from the last 3 hours
(and the newest evidence must be at most 90 minutes old, else `unknown`); a refusal that has since
cleared (a later tick ran normally) no longer counts. The 7-day window's refusals are kept
separately as `history` for display only:

1. `person` — work is waiting on a human decision the system cannot make: the executor's own attempt
   state says awaiting owner review for a CODEOWNERS path, or `approver-not-independent` is latched,
   read from the executor store at evaluation time (async, cached for the hour). A failed read →
   `unknown`.
2. `quota` — the worker paused or was refused for account quota (triage `quotaPause`, executor
   `quota-shedding`) within the window.
3. `cap` — the worker was refused by a fixed cap: executor admission `max-open-prs`,
   `max-starts-per-day`, `max-concurrent`; triage `call-cap-reached`. The detail says what holds the cap, e.g. "4 fix slots held by
   fixes that failed review".
4. `worker` — **positive evidence only**: the worker's own server-recorded tick results show its
   ticks ended on their own time budget (`triage-time-exhausted-rest-due`) with work still queued in
   at least 3 of its last 4 ticks within the evidence window,
   were refused by nothing above, and the projected day stays under the caps: calls used today plus
   the calls the remaining scheduled ticks and any extra ticks would spend stay below
   `maxCallsPerDay`. A tick that stopped at `call-cap-reached` is `cap`, not `worker` (triage's batch size never stops a
   tick; the drain's `maxClaimsPerTick` is a drain limit, not a triage one).
5. `unknown` — none of the above can be shown.

**Tick results (new, server-recorded).** `FeedbackTriageService` now appends one row per tick
ATTEMPT to `logs/queue-pace-ticks.jsonl` in-process, only while `queuePace.enabled`
resolves on (same retention and compaction as the ledger): `{at, kind:'tick', decided, calls, stopReason,
queueDepthAfter}` for a tick that ran (`queueDepthAfter` from the same selectCandidates count the
tick already computes), and `{at, kind:'refused', reason}` for an attempt refused before running
(`acceptTick`'s `rate-limited`, `tick-in-flight` and `not-canonical-owner`). A quota pause is a
`kind:'tick'` row with `stopReason` `quota-pause` or `quota-unreadable-pause`, both of which count as
`quota`. The tuner reads refusals from
these rows, never from the job script's exit (the script reports 409/429/quota-pause as `ok`) or
from a job trigger result. The service also exposes `quotaStatus()` →
`{usedPercent, pauseThreshold}` from the same `quotaUsedPercent` provider it already uses, so the
tuner reads the live percentage, not the paused-only meta. The executor's admission verdict, today a single overwritten meta key, is appended there
too (`{at, admission}`). These rows are written only by the services themselves, never by an HTTP
caller. This is a cooperative boundary, not a security one: a session running as the same OS user
could append to the file. The worst a forged row can do is trigger extra ticks, each of which still
passes every gate. (`POST /skip-ledger/workload` is not used.)

### 3. PaceTuner — act, only where acting helps

v1 tunes exactly one queue: `feedback.triage`. It speeds the worker up by **asking the triage
service for one extra tick in-process** through `FeedbackTriageService.acceptTick()` only (the entry
the scheduled job's route reaches; `tick()` skips the rate limit and is not used), NOT by triggering the job: the `feedback-factory-triage` job runs as a full
Claude session (it is not in the script-runner first wave), so a triggered run would cost a whole
session per extra tick. The service call needs no session, and the service already enforces its own
single flight (`tick-in-flight`), 30 s rate limit, 110 s wall clock, quota pause and daily call cap,
all of which apply to extra ticks exactly as to scheduled ones. `acceptTick()` answers at once
(accepted, `rate-limited`, `tick-in-flight`, `not-canonical-owner`) and runs the tick in the
background; the tick's result — including a `quota-pause`/`quota-unreadable-pause` stop and
`call-cap-reached` — is read afterwards from the service-written tick row for that run, and the
step-down triggers come from that row, never from the call's return value. `not-canonical-owner` is a
step-down (ownership moved). The tuner additionally checks, before
every extra tick, the same ownership predicate the server uses to start feedback ticks (operated
host, holding the serving lease, not restore-pending) and the `queuePace` flags. It never rewrites a
schedule, never raises a cap, a batch envelope, a daily spend or any operator-approved authority
limit. Nothing is queued and nothing is retried: an extra tick that is refused simply did not happen.

- **Step up** after 2 consecutive evaluations of `falling-behind` with bottleneck `worker`, AND
  account quota at least 10 points below the triage quota pause threshold (read from triage's own
  `quotaStatus()`), AND the projected daily call total stays under `maxCallsPerDay`: calls used today
  (the service's own `callsUsedToday`) + (remaining scheduled ticks today + the extra ticks allowed) ×
  the trailing 24 h average calls per budget-exhausted tick (from the tick rows). When the projection
  reaches the cap, the bottleneck is `cap` with detail "the daily sorting call limit would be reached"
  — an operator-owned limit, so no tuning and no attention item; the Pace card says it plainly. This
  may well be the steady state for a large backlog, in which case v1's honest output is the
  measurement and the named cap, not extra ticks. Then: at most one extra tick per
  `minGapMinutes` (10), never within 2 minutes before or after a scheduled tick (a service tick is capped at 110 s), at most `maxExtraRunsPerDay` (12) for the queue, counted per local day in
  `state/queue-pace/tuner.json` (survives restart). **Admission commit:** under single-flight tuner
  admission, the tuner first durably reserves the extra tick (increments the day's count and sets the
  next-eligible time, write-temp-then-rename, fsync) and only then calls the service; the outcome is
  appended afterwards. A reservation whose outcome was never recorded (a crash in between) counts as
  spent. If that file is missing or unreadable while the
  tuner is enabled, the tuner treats the day's budget as spent and the cooldown as active (it waits
  until the next local day plus the cooldown), so losing or deleting state can never grant extra ticks;
  every extra tick is also recorded in `logs/queue-pace-tuner.jsonl`, from which the day's count is
  rebuilt when the file is restored.
- **Step down** on the first evaluation that is not (`falling-behind` + `worker`), on `unknown`, on
  a quota pause or a reached call cap, or when the quota margin is lost. A `tick-in-flight` or
  `rate-limited` answer (the scheduled tick is simply running) is NOT a step-down and starts no
  cooldown: the extra tick is skipped and the next one waits `minGapMinutes`. After a step-down the tuner waits a 6 h
  cooldown before it may step up again.
- **Eligibility is re-checked immediately before every extra tick** (fresh tick and refusal rows,
  live quota, projected calls); this — not the slower 7-day verdict — is the safety check, so a
  changed situation stops extra ticks within one run.
- Every extra tick is admitted through the SelfActionGovernor as class `queue-pace-extra-run`, a
  separate class from the existing `feedback-triage-tick` controller on `reserveCall` (which keeps
  counting the calls themselves; the new class counts the tuner's decisions to add a tick),
  (`direction: 'amplifying'`, `resource: 'hardware-bound'`, ceilings = `maxExtraRunsPerDay`;
  hardware-bound because it runs only on the operated host). The governor
  ships observe-only, so the binding bounds are the tuner's own `minGapMinutes`, daily counter and
  cooldown; the governor adds an independent count. Audit: `logs/queue-pace-tuner.jsonl` (verdict,
  bottleneck evidence, quota margin, decision).
- The tuner never acts on `person`, `quota`, `cap` or `unknown`. The executor's own stall (capacity
  held by rejected PRs) is fixed in the executor, not by tuning
  (`docs/specs/feedback-executor-review-failed-recovery.md`, a separate change).

### Visibility and notices (Self Heal Before Notify)

- **Visible within 300 s** (the registry ceiling `standards.selfHealBeforeNotify.recoverableLatencyCeiling`
  = 300 s): the first `falling-behind` evaluation appears on `GET /queue-pace` and the console Pace
  card immediately. This is the always-on low-noise surface.
- **Escalation (attention item)** only after self-heal is exhausted or unavailable, for `worker`
  queues only: either the tuner has been at `maxExtraRunsPerDay` and the queue is still
  `falling-behind` for 24 h, or the tuner is off / dry-run (no heal available) and the queue has been
  `falling-behind` with bottleneck `worker` for 24 h. The item says which.
  - `class: recoverable`; `remediation-actions`: tuner extra ticks (idempotent: an extra tick while one is
    in flight is refused by the service's own `tick-in-flight` single flight);
    `max-attempts`: `maxExtraRunsPerDay`/day; `max-wall-clock`: 24 h; `backoff`: `minGapMinutes` + 6 h
    cooldown; `dedupe-key`: `queue-pace:<machineId>:<queue>`; `breaker`: an item that reopens 3 times in 7 days is
    held open (not re-raised) and marked "keeps recurring"; `audit-location`: `logs/queue-pace*.jsonl`
    (counts and ids only).
- **`cap` and `quota` have no internal heal**: `quota` heals by the account reset or the pool swap
  (declared; the tuner waits); `cap` is an operator-owned limit. Both are shown on the Pace card with
  the plain reason; neither raises an attention item by itself (the executor's own action list
  already carries its stuck items).
- **`person` is information, not pressure.** Per-PR owner approval of CODEOWNERS paths is a
  constitutional floor. The Pace card shows, neutral colour, no days-to-clear: "N fixes are ready for
  your review" with PR links built only as `https://github.com/<repo>/pull/<n>` from the numbers.
  No attention item, no red. A latched `approver-not-independent` is shown separately as "the fix
  builder is waiting for your one-time acceptance on the dashboard", not as PRs to review.
- An item is cleared only on an affirmative `holding`/`catching-up` verdict with full coverage, never
  on `unknown`; an `unknown` stretch leaves it open and marks it "measurement unavailable".
- All notice text is a fixed template (queue label, counts, PR numbers); no owner-store free text.

### Surfaces

- `GET /queue-pace` (Bearer auth) → `{ queues: [{ id, label, verdict, inflowPerDay, outflowPerDay,
  exitedPerDay, open, daysToClear, bottleneck: {kind, matched[], detail, count}, coverage,
  tuner: {state, extraRunsToday, cooldownUntil}, owner, lastIntervalTo, ok }], context: {
  feedbackReportsPerDay } }`. `?scope=pool` merges machines through the existing pool cache; peer
  rows are clamped and escaped data, never instructions.
- Console: a "Pace" card under Work, one plain line per queue ("Feedback sorting: 120 a day in, 90
  done — falling behind; speeding up"), colour by verdict except `person` (neutral).
- Maturation board: one pace line under the headline for `maturation.fix`.
- Registry First entry, CLAUDE.md template section, PostUpdateMigrator section.

## Maturation plan

- **test-agent-live:** unit tests drive the ledger with fake owners through steady, falling-behind,
  catching-up, shrinking-by-exits, gaps, crashes between row and state, and ownership moves; the tuner
  through worker, cap, quota, in-flight, budget loss and state loss; the e2e test boots the production
  path and gets 200 from `GET /queue-pace`.
- **dev-agent-live:** the ledger, route and Pace card are live on Echo's machines (dev-gated); the
  tuner is enabled in dry-run on the operated host only.
- **fleet:** the ledger and card become default-on after the graduation criterion holds; the tuner
  stays opt-in (`queuePace.tuner.enabled`) on the fleet.
- **graduation criterion:** for 14 consecutive days on the dev agent, ≥ 95% of hourly rows per queue
  are `ok`, zero `count-drift` rows remain unexplained, and every dry-run would-tick had fresh `worker`
  evidence and no gate it would have breached.
- **dark-window:** 14 days.

## Decision points touched

| Decision point | Classification | Justification / floor + arbiter |
|---|---|---|
| Verdict | invariant | Disjoint arithmetic over conserved counts; `unknown` below coverage. |
| Bottleneck kind | invariant | Fixed precedence over owner-recorded evidence; every matched kind recorded; doubt → `unknown`, which only stops the tuner. |
| Tuner extra tick | invariant | Positive `worker` evidence × 2, quota margin, re-check before each run, per-run gap, persisted daily cap, cooldown, the service's own gates, no retry. Worst case: the triage service ticks more often inside limits that already bound it. |
| Escalation raise / clear | invariant | Only after heal exhaustion (24 h at the daily cap); clears only on affirmative recovery. |

## Multi-machine posture

- **Ledger and read surfaces: unified, one owner per queue row.** Rows are keyed `(machineId,
  queue)`. Feedback queues have one owner (`feedbackFactory.operatedHostMachineId`); commitments and
  evolution exist on every machine (each machine's own store; replicated copies are never counted),
  so each machine measures its own. `GET /queue-pace?scope=pool` merges every machine's rows through
  the existing pool fan-out (and the shared pool cache when `ws44PoolCache` is on); each row names
  its machine. Interval history for a queue whose owner changes is read through the same pool read,
  so the previous owner's rows still count; an unreachable previous owner lowers coverage (→
  `unknown`).
- **Tuner: `machine-local-justification: physical-credential-locality`.** Extra ticks call the
  triage service on the operated host, under the subscription login and GitHub credentials that live on
  that machine's disk; triggering elsewhere would spend the wrong login. Only the operated host's
  tuner may act.
- **Notices:** raised by the owning machine with `conditionKey: queue-pace:<machineId>:<queue>`, so
  the pool attention view never merges two machines' queues into one row. When a machine stops
  owning a queue it clears its own open item with resolution "ownership moved".

## Symbol vs state (P20)

| Detector | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| inflow/outflow | id-set diff of owner reads | items really entered/left | conservation equation holds per interval; a violation → `ok:false, reason:'count-drift'` | `ok:false`, verdict `unknown` |
| `worker` | service-written tick rows | the worker, not a gate, limited throughput | positive: decided > 0, depth > 0 after, no refusal in the same row | `unknown`, tuner idle |
| `cap` / `quota` | service-written refusal rows / quota pause | a limit stopped the worker | the refusal row's own reason + counter | `unknown` |
| `person` | executor attempt state (CODEOWNERS wait, approver latch) | a human decision is pending | read at evaluation time from the executor store | `unknown` |
| extra-tick refusal | the service's own answer to the extra tick | it did not run | the matching `refused` tick row | `tick-in-flight`/`rate-limited` → skip, no step-down; quota pause / call cap → step down |
| notice clear | verdict over full coverage | the queue recovered | coverage ≥ 80% and last 3 ok | item stays open, "measurement unavailable" |

## Frontloaded Decisions

- Extra in-process service ticks, not job triggers or schedule rewrites; the tuner never raises caps or operator envelopes.
- Tuned queue in v1: `feedback.triage` only. Defaults: `minGapMinutes` 10, `maxExtraRunsPerDay` 12,
  cooldown 6 h, quota margin 10 points, window 7 d, coverage 80%.
- `queuePace.enabled` is omitted from ConfigDefaults and resolved through resolveDevAgentGate on every
  hourly tick (listed in DEV_GATED_FEATURES as measure-only): the ledger, route and console card are
  live on a development agent, dark on the fleet. The tuner has its OWN explicit flag,
  `queuePace.tuner.enabled` (default false, never dev-gated, because extra ticks spend real quota), and
  `queuePace.tuner.dryRun: true` (logs would-tick, ticks nothing); notices
  `queuePace.notices.dryRun: true`.
- Graduation: the tuner and notices go live after 7 days of dry-run rows in which every would-trigger
  had `worker` evidence and no extra tick would have breached a gate. The development agent (Echo)
  makes that call: it sets `queuePace.tuner.enabled: true` (dry-run) at ship time on Echo only, then
  `dryRun: false` once the evidence holds, recording both in `logs/queue-pace-tuner.jsonl`. Both are
  reversible and read live; the spend they allow is bounded by `maxExtraRunsPerDay` and triage's own
  daily call cap, which this change never raises. Nothing is enabled on the fleet. Cheap-to-change-after: thresholds and defaults, because the
  only acting parts ship dry-run behind named flags. The Pace card wording is user-visible and frozen
  in this spec.
- CartographerSweepPoller keeps its own backlog warning; queue pace does not duplicate or replace it.

## Rollback

`queuePace.enabled: false` stops the ledger, tuner and notices (read live). The new tick rows and
`quotaStatus()` accessor are additive. Only the Pace card and the board's pace line read the ledger, and they
show `unknown` without it; deleting `logs/queue-pace*.jsonl` or `state/queue-pace/` is safe: the ledger restarts with a
`baseline` row and the tuner fails closed for the rest of the day.

## Open questions

*(none)*
