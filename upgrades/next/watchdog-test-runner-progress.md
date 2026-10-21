# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **A test run that is still working is no longer stopped at the hour mark.** The watchdog's test-runner floor protected a suite for its first hour and then expired on wall clock alone. Because the hard ceiling is 30 minutes, every fail-closed path already votes to interrupt by the time the floor lapses — so the hour mark was not a handover to judgement, it was a scheduled kill for any run that long. Past the floor, `classifyTestRunnerProtection` now also consults measured work: the candidate's **subtree** CPU time (the `npm test` parent waits while its pool workers do the work, so the parent's own CPU time is not the signal), sampled from the same single `ps` snapshot, which gains a `time=` column and spawns no extra process. A new `TestRunnerProgressTracker` (pure, injected clock) turns two readings of one pid into `progressed` / `idle` / `baseline` / `unknown`, comparing samples at least 20 s apart and requiring 1 s of CPU to count as work. Only evidence extends protection: `unknown` — an unreadable or absent CPU column — behaves exactly as before, which is why every pre-existing floor test passes untouched. A first sighting yields `baseline` and buys one poll, so a watchdog meeting an already-old run (after a server restart) cannot interrupt it having measured nothing at all. The extension is bounded by a new `MAX_TEST_RUNNER_ABSOLUTE_MS` of three hours, after which the normal judge decides regardless.
- **An interrupted test run is announced instead of being interrupted in silence.** A watchdog Ctrl+C is routine for most commands and stays silent, but interrupting a test run discards everything the run had completed — and the harness that launched it can still report a clean exit, so nobody learned the run had been cut short. The intervention event now carries `stuckCommandKind` (`test-runner` / `test-runner-ancestor`, decided at detection time where the live descendant snapshot is available), plus `stuckElapsedMs` and `stuckRetryCount`; `formatWatchdogUserMessage` turns the first intervention of an episode into one plain line naming the duration and saying nothing it finished was kept. Later escalation steps add no second line.

## What to Tell Your User

If you run a long test suite, I will not interrupt it at the one-hour mark any more while it is genuinely working — I now look at whether it is still using processor time, and leave it alone while it is, up to three hours. And if I do stop a test run because it looked stuck, you will hear about it: one line telling you how long it had been running and that it needs running again. Before, I stopped it quietly and the tool that started it could still report success, so an hour of work could disappear and look like it had passed.

Known limit, stated plainly: processor time is a proxy for progress. A run stuck in a loop that keeps the processor busy without finishing will now be left alone for up to three hours instead of one.

## Summary of New Capabilities

- `src/monitoring/testRunnerProgress.ts` — `TestRunnerProgressTracker`, `parseCpuTime`, `MIN_PROGRESS_SAMPLE_GAP_MS`, `MIN_PROGRESS_CPU_DELTA_MS`, `SAMPLE_RETENTION_MS`.
- `MAX_TEST_RUNNER_ABSOLUTE_MS` (3 h) and a `progress` parameter on `classifyTestRunnerProtection` / `classifyProtectedWait`; `ProtectedWaitEvidence.extendedByProgress`.
- `InterventionEvent.stuckCommandKind` / `.stuckElapsedMs` / `.stuckRetryCount` (additive on `.instar/watchdog-interventions.jsonl`).

## Evidence

- Live incident, `logs/server.log` 2026-10-21: `02:27:46Z` a `git push --force-with-lease` running a pre-push tier interrupted at 3615 s, `04:55:50Z` a full `npm test` interrupted at 3610 s — both one second past the floor, neither announced; another session's suite on the same tick logged `protected wait (test-runner)` because it was younger.
- `tests/unit/watchdog-test-runner-progress.test.ts`: both sides of every bound (floor, absolute ceiling, CPU delta, sample gap); `parseCpuTime` returns `undefined` rather than `0` for an unreadable cell; a too-close poll reports the standing verdict instead of flapping; CPU going backwards re-baselines rather than judging; retention expiry and pruning.
- `tests/unit/watchdog-notifications.test.ts`: the notice fires at Ctrl+C level (silent for every other command), once per episode, names the duration, says the work is gone, carries no jargon or raw command, and stays silent for an ordinary stuck command.
- `tests/unit/session-watchdog-test-runner-floor.test.ts`: unchanged and still passing — the proof that an unmeasured run behaves exactly as it did.
- `tests/integration/session-watchdog-safe-wait.test.ts`: the watchdog pipeline past the floor (climbing CPU is neither judged nor signalled; frozen CPU is), the absolute bound, the intervention event carrying the kind, and a real CPU-burning process read out of the real process table with an advancing `time=` column.
- `tests/e2e/watchdog-test-runner-progress-alive.test.ts`: a real `npm test` subtree (npm → node, real CPU), enumerated by the production snapshot with only the clock aged past the floor, across two real 21 s polls — spared with `protected wait (test-runner, still working)` while climbing, interrupted and announced when its CPU readings are pinned.
