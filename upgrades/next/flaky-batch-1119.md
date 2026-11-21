<!-- internal-only -->

# Three load-sensitive tests wait for the real condition

## What Changed

Three tests that failed full verify runs on a loaded machine, and passed alone, no longer depend on how busy the machine is. Test files only; no runtime code changed.

- `tests/integration/cartographer-eventloop-worker.test.ts`: the two event-loop cases measure the CPU time the test's own thread used between two turns of the loop. They no longer measure how late a timer fired, which also counted time the processor spent on other programs. A new case checks the measuring probe itself.
- `tests/e2e/session-management-e2e.test.ts`: the build-context respawn case and the slow-start case wait for the session manager to report the message injected. The build-context case also waits until the pane directory is recorded and checks the recorded value.
- `tests/unit/job-portable-bundle.test.ts`: the real python file helper is still used, with its 1.8 to 3 second limit lifted to 60 seconds inside this test file.

The helper's time limit in product code is unchanged and remains reported as fb-fe25893b-2ad.

A fourth test, `tests/integration/graph-witness-chunks.test.ts`, failed about one run in 64 for a different reason: it damaged a piece of data by overwriting its first character with `A`, which changed nothing when that character already was `A`. The damage now always changes the data.

## What to Tell Your User

Nothing to tell. This is an internal repair to automated tests; nothing an agent or its user sees has changed.

## Summary of New Capabilities

None — internal change.

## Evidence

- Failure messages taken from the local verify run logs and flaky history, 2026-11-12 to 2026-11-19.
- Each changed file run alone five times in a row, then once more with eight busy-loop processes started when the run took its test slot: `tests/unit/job-portable-bundle.test.ts` 11 of 11 passed in all six runs; `tests/integration/cartographer-eventloop-worker.test.ts` 8 of 8 in all six; `tests/e2e/session-management-e2e.test.ts` 33 of 33 in all six.
- Event-loop probe readings (a temporary print, removed before the commit): detect case 3 to 4 ms of thread work per loop turn; population case 26 to 31 ms on a quiet run. Under the load run the population case read 31 ms of thread work while the old wall-clock reading in the same run was 160 ms.
- Portable-job mock checked by setting its replacement limit to 1 ms: the helper-backed cases then fail with `spawnSync python3 ETIMEDOUT`.
- `npx tsc --noEmit -p .` clean; the three test files type-checked separately with no error on a changed line.
