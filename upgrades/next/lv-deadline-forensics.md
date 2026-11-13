## What Changed
When a Local Verify lane hits its time limit, the run now records which test files were still running at the kill (and for how long) in its log and error reason, and stops the run's other lanes at once instead of letting them run to the end. The lane reporter keeps a small, throttled snapshot of the files in flight; it is information only and never affects a verdict.

A green PR verify after `main`'s own error retries ran out now queues one more `main` verify. Before, `main` stayed unverified after three errored checks, and the merge watcher stopped offering changes to the queue until a restart.

Each machine can set its own unit-lane worker count with `monitoring.localVerify.laneShards.unitWorkers` (1..12; default 4), read at each run start like the shard counts. It changes how many unit test files run at once, never which ones.

The lane time limits are now hang limits, not speed targets: unit 40, integration 45 and e2e 60 minutes (were 20, 30 and 45), about twice the measured normal, after healthy runs were being killed at the old limits on 2026-11-12. And the verify's own unit lane is no longer held to 4 workers by the host test-runner bound: the run that holds the suite slot declares that lane as its own, so a configured `unitWorkers` above 4 takes effect. Every other nested test run is clamped as before.

## What to Tell Your User
When a test run on the way to merging times out, I can now see which test was stuck instead of guessing, and the machine is freed for the next change sooner. Changes waiting to merge also no longer stall for hours after the main branch's own check times out a few times. Nothing for you to do.

## Summary of New Capabilities
- Per-machine unit-lane worker count: `monitoring.localVerify.laneShards.unitWorkers`.
- Deadline forensics: `deadline-in-flight` events in Local Verify run logs, naming the files still running when a lane was killed.

## Evidence
- `tests/unit/localVerify/orchestrator.test.ts`: a deadline stops sibling lanes with and without fail-fast; the running files reach the log and the error reason; an unreadable snapshot is recorded as unknown.
- `tests/unit/localVerify/unhandledErrorsReporter-progress.test.ts`: start/finish tracking, no env no write, malformed input is null, bounded list.
- Real vitest 2.1.9 run with the reporter: the snapshot file was written with the running file.
