# Local Verify: a PR verify stops its other lanes once one has a real failure; flaky-on-main files get their re-run

## What Changed

- `src/localVerify/orchestrator.ts`: with `VerifyRunInput.failFast` (PR verifies only), the first lane that ends with a failure its isolation re-run did not clear stops the lanes still running (`lanes-stop`, `lane-stopped-early:<lane>`). `main` verifies always run every lane. A failed file that was re-run-passed on the last green `main` is no longer refused its one isolation re-run (logged `isolation-rerun-flaky-on-main`); the changed-file, import and no-green-main rules are unchanged.
- `src/localVerify/laneReport.ts`: a stopped lane is reported after every real reason and its files are not `file-not-run`; stopped lanes alone can never make a run succeed.
- `src/localVerify/orchestratorSeams.ts`: `realExec` takes an abort signal; a stop or a deadline now signals the process and all its descendants (SIGTERM, then SIGKILL after the grace to every pid whose start time and command are unchanged), and after a stop the wait for its pipes is bounded at 5 s once it has exited.
- `src/localVerify/LocalVerifyService.ts` + `localVerifyWiring.ts` (`wireLocalVerifySwitches`): live switch `monitoring.localVerify.failFast` (absent ⇒ on, read at each start).
- Agent awareness: template bullet + `PostUpdateMigrator` line.

## What to Tell Your User

Nothing changes for an ordinary agent. For maintainers who run Local Verify: a pull request test run that has already failed now stops early instead of running its slower test groups to the end, so the next pull request starts sooner, and a test that is known to be flaky on main gets its one retry instead of failing unrelated pull requests.

## Summary of New Capabilities

- Local Verify fail-fast for pull request verifies, with the switch `monitoring.localVerify.failFast` (on by default).

## Evidence

Measured on the Studio journal, 2026-10-20..26: 121 verifies, median 18.5 min, 32 failures and 15 errors; about 15 of 48 failed runs failed only on a file refused its re-run because it was flaky on `main`. Unit: all of `tests/unit/localVerify/` (fail-fast stop, null-exit clean report, re-run interrupted by another lane, main verify never stops, flaky-on-main re-run and its PR-changed exception, process-tree stop with a pipe-holding descendant, SIGTERM-resistant child and descendant, deadline-before-abort, bounded close, pid identity); independent Codex review, 5 rounds; `PostUpdateMigrator-localVerifyMainRedHold.test.ts` 8/8; e2e `local-verify-lifecycle.test.ts` 9/9 (switches wired through the production function).
