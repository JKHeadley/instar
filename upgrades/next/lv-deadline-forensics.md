## What Changed
When a Local Verify lane hits its time limit, the run now records which test files were still running at the kill (and for how long) in its log and error reason, and stops the run's other lanes at once instead of letting them run to the end. The lane reporter keeps a small, throttled snapshot of the files in flight; it is information only and never affects a verdict.

## What to Tell Your User
When a test run on the way to merging times out, I can now see which test was stuck instead of guessing, and the machine is freed for the next change sooner. Nothing for you to do.

## Summary of New Capabilities
- Deadline forensics: `deadline-in-flight` events in Local Verify run logs, naming the files still running when a lane was killed.

## Evidence
- `tests/unit/localVerify/orchestrator.test.ts`: a deadline stops sibling lanes with and without fail-fast; the running files reach the log and the error reason; an unreadable snapshot is recorded as unknown.
- `tests/unit/localVerify/unhandledErrorsReporter-progress.test.ts`: start/finish tracking, no env no write, malformed input is null, bounded list.
- Real vitest 2.1.9 run with the reporter: the snapshot file was written with the running file.
