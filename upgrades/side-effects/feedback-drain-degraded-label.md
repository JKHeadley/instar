# Side-Effects Review — out of tick time is a clean stop; the drain job reads slow runs

**Version / slug:** `feedback-drain-degraded-label`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Live on 2026-10-01 (Mac Studio, v1.3.1314, authority gen 4 `maxBatch` 50, 90 s tick), drain
runs ef0f6cbf and 10674e04 each ran 70 s. Each made two good readiness calls: ~32 s and ~62 s
in, 10 + 9 and 10 + 6 candidates. Then each started a ONE-candidate call with 7.6 s / 7.8 s
left. The pace-based sizing (`remaining / (1.25 × ms per candidate)`) assumes a call costs
only its per-candidate time. Live calls also pay about 9 s of start-up (6 candidates 23.2 s,
9 candidates 30.2 s, 10 candidates 32.2 s). So the service's own `withStageBudget` timer cut
the call at exactly 70.0 s, the readiness deadline. `failed()` then marked the row
`readiness-authority-failed` and the run `degraded`, with zero provider errors in
`/metrics/features`.

`FeedbackDrainService.reviewReadinessInChunks`:
- A call after the first needs at least `MIN_LATER_READINESS_CALL_MS` (25 s) left. Below
  that, the loop stops.
- If the stage timer (`StageBudgetExceeded`, a new private Error subclass with the same
  message) cuts a LATER call whose budget was shortened by the tick clock
  (`callBudgetMs < readinessStageBudgetMs`), that is out of time, not a provider failure.
  The loop stops, and the call's rows stay due, untouched.
- In both cases, after at least one successful call, the tick records `out.note =
  'readiness-time-exhausted-rest-due'`. `FeedbackDrainTickResult.note` is a new optional,
  informational field: it never degrades the run. `transitionRun` stores `reason ?? note`,
  so a `succeeded` row can carry the note in its reason column.
- Unchanged: no call made at all → degraded `readiness-wall-clock-exhausted`. A first call
  that times out, a provider timeout or error (`CodexExecJsonTimeoutError` etc.), a contract
  violation and the spend brake are all still degraded.

The `feedback-factory-process` job body (`src/scaffold/templates/jobs/instar/feedback-factory-process.md`):
- The installed body WAS the new script (PR #2111). Its 60 s poll ended before the 70 s runs
  finished, and it printed `still in flight; the next cadence observes it` (both job
  transcripts show this) and exited as a success.
- The scheduler's declared-failure file (`INSTAR_JOB_FAILURE_FILE` → `readJobDeclaredFailure`
  in `JobScheduler.notifyJobComplete`) is wired correctly. It was never written.
- Now: the default poll is 180 s (above the service's 115 s wall-clock ceiling). A run still
  in flight after the poll FAILS the job. `expectedDurationMinutes` goes from 2 to 5, so the
  session budget covers a 180 s poll plus model start-up.

## Decision-point inventory

- Drain readiness loop stop/continue (`FeedbackDrainService`): modify. One extra stop
  condition (a time floor for later calls), and a stage-timer cut of a time-shortened later
  call is reclassified as a clean stop.
- Run outcome labelling: modify. A tick that stops for time after a successful call is
  `succeeded` with a note, not `degraded`.
- Job tier-1 supervision (`feedback-factory-process` script): modify. "Still in flight at
  the poll limit" goes from success to a declared failure, and the poll is 3× longer.

---

## 1. Over-block

- The job now fails on a run still in flight after 180 s. The service throws
  `feedback drain wall-clock budget exceeded` past 115 s, and the run lease is 120 s, so a
  run alive at 180 s is stuck. Failing the job surfaces it. One false failure is possible if
  the status route itself is unreachable for the whole poll. That is a real fault too.
- The 25 s floor can leave a few candidates unreviewed in a tick where a short call might
  just have fitted. They stay due and go first next tick (due order `next_review_at,
  cluster_id`). It costs about 1-2 candidates per tick and never rejects anything.

---

## 2. Under-block

- A later call cut by the tick clock after an earlier success no longer counts toward
  degradation. If the provider is really slow on that one call, it is hidden in that tick.
  The next tick's first call has the full budget, and if it fails it is degraded as before.
  A provider that keeps getting slow therefore still surfaces.
- The reclassification requires `StageBudgetExceeded` AND a shortened budget AND an earlier
  success. A provider timeout raises its own error class, so it is never reclassified.

---

## 3. Level-of-abstraction fit

This is the right layer. The tick budget and its run labelling belong to the drain service.
The job script is the tier-1 supervisor of exactly this run outcome. No new gate or table is
added.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

These are resource and timekeeping bounds plus honest outcome labelling. The readiness
judgment stays with the registered LLM authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic at a competing-signals decision point. The 25 s floor is a measured resource
bound. Fitted to the live calls, a call costs ~9 s plus ~2.4 s per candidate. The pace estimate
(with its 25% margin) only stays safe with about 23 s or more left; the reviewer derived this,
and the floor was raised from 15 s to 25 s to match.

---

## 5. Interactions

- `onRecoverableStall` fired on every degraded run. These two live runs called it. A
  time-stopped run no longer does.
- `pruneOperationalHistory` runs only for non-degraded runs, so it now also runs after a
  time-stopped tick. That is the same as any succeeded tick.
- Transient-failure counter: unchanged. Any successful call clears it, and a clean stop is
  not a failure.
- A cut later call's codex child keeps running until its own 60 s timeout (named in PR #2112
  as well). The 25 s floor makes this rarer. 30-minute ticks never overlap.
- `FeedbackDrainTickProxy` and the status route pass the run's `reason` through. A succeeded
  run can now show the note there. The job script reads `reason` only for non-success
  states.

---

## 6. External surfaces

- The job body and its manifest are replaced on update by `installBuiltinJobs`. That covers
  the body, `expectedDurationMinutes` and the operator's `enabled`, which is preserved
  (Migration Parity is covered by the existing body-refresh test). No config, route, schema
  or CLAUDE.md template change.
- Model spend: slightly lower, because the doomed last call is no longer made.

---

## 6b. Operator-surface quality

Not applicable. No operator surface is touched (the run reason is already shown as-is).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Unchanged. Readiness runs only on the canonical owner. A proxied tick still finishes the job
at once ("the owner records its outcome").

---

## 8. Rollback cost

Low. Revert the commit. There are no data-shape changes. A `succeeded` drain_runs row may
hold the note in `reason`, which older code reads as an ordinary bounded string.

---

## Conclusion

The run label now tells the truth in both directions. A tick whose calls all succeeded but
ran out of time is `succeeded` (with a note), and the rest stays due. A degraded run reaches
the operator, because the job now waits past the drain's wall clock instead of reporting
success at 60 s.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

The reviewer ran the targeted tests: unit 15/15, integration 17/17, e2e 1/1. Its notes, and
what was done with each:
- The 15 s floor was below the ~23 s at which the start-up-blind pace estimate is safe.
  Applied: the floor is now 25 s.
- Nothing tested that our timer cutting a later call that had its FULL budget stays degraded.
  Applied: a new unit case.
- One test name said "full budget" when the budget was shortened. Applied: renamed. That case
  proves a provider error is never reclassified.
- The job's in-flight failure did not say what it last saw. Applied: it now includes the last
  `lastRun` id and state, or the HTTP code.
- Left as is (named): the real-timer `setTimeout` race path is not separately unit-tested.
  Both paths throw the same class, and the post-check path is covered.

## Evidence pointers

- Live store (read-only `.backup` at /tmp/fac-degraded/drain.db): drain_runs ef0f6cbf
  (22:49:40) and 10674e04 (23:00:24). Readiness rows were stamped at +32.2 s / +62.4 s /
  +70.0 s and +39.0 s / +62.2 s / +70.0 s. Exactly one `readiness-authority-failed` row per
  run, at the 70 s deadline.
- Job transcripts: `FEEDBACK_DRAIN_RESULT run run:ef0f6cbf-… still in flight; the next
  cadence observes it` (and the same for 10674e04).
- `tests/unit/feedback-factory/drain-readiness-chunking.test.ts`: five new cases cover the
  live shape (9 s + 2.33 s per candidate → calls [10, 9], succeeded with the note, 31 rows
  untouched), a stage-timer cut of a later call (clean), the same cut on the first call
  (degraded), a provider timeout with a shortened budget (degraded), and our timer cutting a
  later call that had its full budget (degraded). Three existing
  expectations move from [10, 10, 2] to [10, 10] because of the floor.
- `tests/integration/feedback-drain-time-exhausted.test.ts`: production wiring + HTTP status
  report `succeeded` with the note. It fails on the pre-fix source.
- `tests/integration/feedback-factory-process-job-body.test.ts`: four new cases cover the
  default poll above 115 s, a slow degraded run that still fails the job, a slow succeeded
  run with the note counted as success, and in flight after the poll → failure. Two fail on
  the pre-fix body.
- `tests/e2e/feedback-drain-time-exhausted.test.ts`: the shipped job script against the
  production AgentServer with the live latency shape. Pre-fix calls are [5, 4, 1] (the live
  shape) and the run is degraded. Post-fix calls are [5, 4], the run succeeded with the note,
  and the job records success.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect class: the defects are a missing fixed-cost term in a
TypeScript time estimate, and a poll shorter than the thing it polls. Convergence of the
modified loop: at most `ceil(maxBatch / readinessChunkSize)` calls per tick. It stops at the
floor or the deadline, and any non-time failure still ends the readiness stage.
