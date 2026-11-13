# Telegram-origin recording budgets: one test-wide default instead of per-file overrides

<!-- bump: patch -->

## What Changed

The per-stage recording budgets of `TelegramOriginService` (250 ms store, 500 ms spool, 1250 ms peer, 1000 ms verified evidence, 1000 ms admit) move to a small import-free module, `src/messaging/telegram-origin/OriginStageDeadlines.ts`. It adds a process-wide default: `setOriginStageDeadlineProcessDefaults(partial | null)`. A stage's budget resolves as the service's own `stageDeadlines` value when valid, else the process default when one was set, else the production budget (`resolveOriginStageDeadline`). `TelegramOriginService.ts` re-exports the moved names, so existing imports are unchanged.

`tests/vitest-setup.ts` sets all five stages to 20 s for every test file.

Production behaviour is unchanged: nothing under `src/` calls the setter, and a unit test scans the source tree to keep it so.

## What to Tell Your User

Nothing changes that you will see. This stops a family of tests from failing unrelated changes when the test machine's disk is busy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Process-wide default for origin recording budgets (tests only) | `setOriginStageDeadlineProcessDefaults` in a test setup file |

## Evidence

Local Verify audit, 2026-11-07 to 11-13: 29 failed runs across 17 PRs on nine telegram-origin test files, none of the PRs touching that code; failures concentrate on the Studio, whose disk is shared with the live agent. On 2026-11-13 18:18Z PR 3133 failed on `tests/unit/telegram-origin/held-reply-outcome.test.ts` and `store-worker-recovery.test.ts`, two files outside the thirteen covered by the two earlier per-file fixes.

Also in this change: `tests/unit/JobScheduler-script-job.test.ts` waited for its marker file to exist and then read it; the shell creates the file before it writes, and on 2026-11-13 18:49Z a read landed in between and failed PR 3145's run (`expected '' to be 'token=...'`). It now waits for the content.

Tests: `tests/unit/telegram-origin/origin-stage-deadlines.test.ts`, 5 new (23 in the file): a process default applies to a service with no budget of its own; a service's own budget wins; `null` restores production budgets and invalid fields are ignored stage by stage; nothing under `src/` calls the setter; the budgets module imports nothing. Run locally and passing: that file with `held-reply-outcome`, `store-worker-recovery` and `origin-service` (4 files), and `JobScheduler-script-job` (5 tests). The full telegram-origin directory was not run locally (56 files count as a suite and would hold the verify slot); Local Verify runs it.
