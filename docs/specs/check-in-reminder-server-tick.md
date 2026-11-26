---
title: Check-in reminder server tick
slug: check-in-reminder-server-tick
status: draft
tier: 1
parent: docs/specs/dated-commitment-reminder.md
commitment: CMT-1130
eli16-overview: docs/specs/check-in-reminder-server-tick.eli16.md
review-convergence: "2026-10-30T19:03:04.114Z"
review-iterations: 2
review-completed-at: "2026-10-30T19:03:04.114Z"
review-report: "docs/specs/reports/check-in-reminder-server-tick-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Check-in reminder server tick

## Problem

`commitments.checkInReminder` has a working pass (`POST /commitments/check-in-reminder/pass`)
but nothing calls it. The built-in job that was meant to drive it ships `enabled:false`,
because on any agent where script runners are not active for that slug (today, every agent:
`GET /jobs` reports `runner: session`) a `*/5` job would spawn a session every five minutes.
So every dated promise sits unreminded. On the dev agent, 16 commitments are in that state,
the oldest due 2026-10-22, and the promised 7-day soak could never start because no pass ran.

## Change

A server-owned timer runs the same pass with no session and no LLM.

1. `AgentServer` owns one `setInterval` (`unref`'d, cleared on stop), following the
   `windowLifecycleTick` precedent: `createRoutes` installs `ctx.checkInReminderTick`.
   It is armed only when a commitment tracker exists.
2. The route and the tick share one pass builder, so both use the same deterministic delivery,
   dedup and origin path. The reconciler and its send-then-stamp logic do not change.
3. Passes are single-flight in process. A route call that lands during a tick pass shares that
   pass's result instead of starting a second scan over the same due rows. Send-before-stamp means
   the CAS stamp alone would not stop two concurrent passes from both sending; this does. A pass
   still running after 10 minutes is never overlapped, because that could double-send the row it is
   stuck on: each later tick counts as a failure with `pass-stalled`, feeding the same one-report
   streak, until the pass settles or a restart clears it, and the pass route answers 503
   `check-in-reminder-pass-stalled` rather than wait on it. Sends carry the transport's own 15 s
   request timeout, so this is a backstop.
4. The first tick fires after one full interval, never at boot, when Telegram may not be ready.
5. Each tick re-reads the same gates as the route: dev-agent gate, tracker, transport (required
   only when `dryRun` is false), plus `tickEnabled`. A tick whose gates fail does nothing.

### Config (all inside `commitments.checkInReminder`; absence is the default)

| Key | Default | Read |
|---|---|---|
| `dryRun` | `true` (unchanged) | every pass, through LiveConfig |
| `tickEnabled` | `true`: the tick follows the feature gate | every tick, through LiveConfig |
| `tickIntervalMs` | `300000` (floor `1000`) | at server start |

No config migration: absent keys are the defaults.

### Soak evidence

`dryRun` logs one line per would-send row. At 16 rows every five minutes that is about 4,600
identical server-log lines a day, so tick passes are quiet in the server log and write to
`logs/check-in-reminder-tick.jsonl` instead: one row when the due-id set changes, when anything
was sent, failed or given up on, and at least hourly otherwise. Rows hold ids and counts, never
the promise text. Rotation: one `.1` generation past 5 MB. A write failure is counted and never
stops a pass. The first completed tick after a start always writes a row, and the hourly timer
does not survive a restart. A server that restarts inside every interval never ticks. A ledger gap
shows that no pass was recorded, not why: read it beside the startup log and `tick.lastSkip`.

`GET /commitments/check-in-reminder` gains `tick`:
`{ armed, enabled, intervalMs, ticks, lastTickAt, lastSkip, lastReport, consecutiveFailures, lastError, ledgerWriteFailures }`.

### Failure surfacing

The job's `undelivered-reminders` anomaly no longer fires when no job runs, so the tick carries it:

- `gaveUp > 0` on any pass, tick or route, raises ONE Attention item (stable id
  `check-in-reminder-undelivered`, `needsUser` so the hub filter admits it), because those promises
  did not reach the user. It cannot fire in dry-run.
- Three consecutive thrown passes file one `DegradationReporter` report per streak; a
  successful pass ends the streak.

### Multi-machine posture: machine-local by design

This SUPERSEDES the parent spec's "pass runs on the serving-lease holder ONLY". The parent assumed
one unified store; the shipped store is per machine. `state/commitments.json` is git-ignored, and
peers' rows land in the separate `commitmentReplicaStore` for merged reads, never in the tracker
this pass scans. A lease-only pass would silently never remind any promise made on a standby, so
each machine drives its own store. There is no second copy to double-send. The cost: a reminder
owned by a machine that is down waits for that machine to return, because the surviving machine
never scans a replica. Hold-and-forward covers delivery from a live machine, not this.
As a belt, `isCheckInReminderDue` gains `other-machine`: a row stamped with a different
`ownerMachineId` than this machine is not due, whichever path calls the pass. An unstamped row or
an unknown self id stays eligible, so a single-machine agent is unchanged. Delivery on a machine
that does not hold the serving lease uses the existing origin hold-and-forward path, so topics
keep one voice.

### Proof

Tier 3 boots the real `AgentServer` with `dryRun:false`, a real `CommitmentTracker` file store,
the real `TelegramAdapter` over a stubbed Telegram HTTP layer, and a 1 s real timer. One genuinely
due commitment must produce exactly one HTTP send across several ticks and across a server
restart on the same state, with a not-yet-due and a delivered sibling producing none and the
session manager never asked to spawn. A second E2E pins that the default config ticks in dry-run
and sends nothing.

Honest limit: this proof uses a stubbed Telegram endpoint, because the live flip is the
operator's and this change stays dry-run. The first real send happens at that flip.

## Not changing

- `dryRun` stays default true, so a default config sends nothing. No agent sets `dryRun:false`
  today; one that did would gain a live driver from this change, on the feature it opted into.
- The job and its script stay; a job run is safe beside the tick (same single-flight, same stamp).
- `POST /commitments` still refuses `checkInAt` as a sole follow-through choice.

## Flip prerequisite (recorded, not built here)

At `dryRun:false` the current backlog would post in one pass, up to `maxPerPass` (25), including
promises over a week old. Before the flip the soak ledger's ids should be reviewed and stale rows
closed. That review is the operator-facing part of the 7-day soak on CMT-1130; `maxPerPass` is
the existing lever.

## Decision points touched

- `isCheckInReminderDue` `other-machine` clause: `invariant`, arithmetic over two ids that only narrows sends.
- Tick skip gates: `invariant`, re-reading existing config that can only stop a pass.

## Maturation plan

- **test-agent-live:** the Tier 3 proof above, with the real server, timer, store and Telegram adapter.
- **dev-agent-live:** on merge the development agent ticks in dry-run; `logs/check-in-reminder-tick.jsonl` is the evidence.
- **fleet:** dark, because the feature gate is dev-agent-only until a separate decision.
- **graduation criterion:** 7 days of dev-agent ticks with `consecutiveFailures: 0`, the would-send ids reviewed and stale rows closed, then one real due reminder observed once on Telegram after the operator sets `dryRun: false`.
- **dark-window:** 7 days from the first dev-agent tick, tracked by CMT-1130.

## Rollback

`commitments.checkInReminder.tickEnabled: false` stops it on the next tick with no restart.
Reverting the PR removes the timer; no state migrates. The CLAUDE.md wording migration is
text-only and harmless if the code reverts.

## Open questions

None.

## Left behind

- Round 2 (GPT-6 Astra): zero design findings; three precision notes applied above, with overlap
  and stalled-pass coverage in `tests/unit/check-in-reminder-ticker.test.ts`.
- Cross-model review (GPT-6 Astra) round 1: two design findings, both resolved above (the parent's
  lease rule, the unbounded in-flight pass) and two precision findings, both resolved above
  (restart claim, default-config claim). Gemini was unavailable (`gemini-not-authed`).
- A held forward on a non-lease machine counts as a failed attempt until delivered, so a long
  lease partition can record `checkInReminderFailedAt`. That errs loud, not silent, and the
  origin's durable hold still delivers the original.
