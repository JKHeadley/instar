# Feedback drain: running out of tick time is a clean stop, and the job reads slow runs

## What Changed

Two live faults on 2026-10-01 (Mac Studio, v1.3.1314, authority gen 4 with `maxBatch` 50):

- **A good tick was labelled degraded.** Runs ef0f6cbf and 10674e04 each made two good
  readiness calls (about 20 and 17 decisions applied, zero provider errors). Then each started
  a one-candidate call with under 8 s left. A call also pays about 9 s of start-up that the
  per-candidate pace does not show, so the drain's own tick clock cut it at 70.0 s, and the
  run ended `degraded` / `readiness-authority-failed`.
  - A call after the first now needs at least 25 s left (`MIN_LATER_READINESS_CALL_MS`).
  - If the tick clock (not the provider) cuts a later call short, its rows stay due,
    untouched.
  - Either way, a tick that already reviewed some candidates ends `succeeded`. It carries
    the note `readiness-time-exhausted-rest-due` in the run's reason.
  - Real failures stay degraded: a provider timeout or error, a contract violation, the
    spend brake, or a first call that cannot finish.
- **The job recorded those degraded runs as successes.** The `feedback-factory-process` body
  polled for 60 s, the runs took 70 s, and it exited "still in flight; the next cadence
  observes it". No later cadence ever reads an earlier run. It now polls for 180 s, which is
  above the drain's 115 s wall-clock ceiling. A run still in flight after that fails the job.
  `expectedDurationMinutes` goes from 2 to 5. Existing agents get the new body and manifest
  through `installBuiltinJobs` on update. The scheduler's declared-failure file was already
  wired correctly.

## Evidence

- Live store (read-only `.backup` copy): both runs' readiness rows were stamped at about 32 s,
  62 s and 70.0 s. The single 70.0 s row in each run was marked `readiness-authority-failed`.
- The job transcripts read `FEEDBACK_DRAIN_RESULT run run:ef0f6cbf… still in flight` and
  `… run:10674e04… still in flight`.
- Unit, integration and e2e tests use the live latency shape (a fixed start-up cost plus a
  per-candidate pace). The e2e runs the shipped job script against the production
  AgentServer. On the pre-fix source the calls are `[5, 4, 1]` and the run is degraded. After
  the fix the calls are `[5, 4]`, the run succeeded with the note, the rest stays due, and the
  job records success.

## What to Tell Your User

The feedback sorter sometimes ran out of time near the end of a run and wrongly called the
whole run a failure, even though every answer it got was fine. It now just stops and leaves
the rest for the next run. Its scheduled job also waits long enough to see how a slower run
ended, so real failures show up as failures. Nothing for you to do.

## Summary of New Capabilities

- Drain runs that stop for lack of tick time end `succeeded`, with the note `readiness-time-exhausted-rest-due`.
