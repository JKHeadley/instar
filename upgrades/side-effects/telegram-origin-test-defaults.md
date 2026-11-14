# Side-Effects Review — one test-wide default for telegram-origin recording budgets

**Version / slug:** `telegram-origin-test-defaults`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end)`

## Summary of the change

Tier 1. The five per-stage recording budgets of `TelegramOriginService` move from `TelegramOriginService.ts` to a new import-free module `src/messaging/telegram-origin/OriginStageDeadlines.ts`, which adds a process-wide default (`setOriginStageDeadlineProcessDefaults`) and the resolver the service now calls (`resolveOriginStageDeadline`: the service's own valid value, else the process default, else the production budget). `TelegramOriginService.ts` re-exports the moved names. `tests/vitest-setup.ts` sets all five stages to 20 s for every test file. `tests/unit/JobScheduler-script-job.test.ts` waits for its marker file's content instead of its existence (a read-before-write race that failed PR 3145's run on 2026-11-13).

Why: 29 failed Local Verify runs across 17 unrelated PRs in a week on tests that open a real origin service on a loaded disk; two per-file fixes did not keep up with 46 files.

## Decision-point inventory

`TelegramOriginService` decides whether a send is held when recording is slow. In production that decision is unchanged: the budgets are the same constants and nothing under `src/` calls the setter. In tests, the default wait before a slow stage is treated as an outage rises to 20 s.

---

## 1. Over-block

None added. Production budgets are unchanged.

## 2. Under-block

In tests only: a stage that is slow but under 20 s is no longer treated as an outage unless the test sets its own budget. What still bounds it: the store's per-request deadline (2 s unless a fixture raises it), which is not touched. A sink that rejects, or a closed store, still fails at once.

A test that relied on a stage timing out by itself at the production budget, without setting it, would wait 20 s. The six files that assert `all-durable-recording-sinks-unavailable` or `execution-admission-unavailable` outside the budget tests were read: each produces the hold with a rejecting mock or a closed store, none with a slow sink.

## 3. Level-of-abstraction fit

The budget belongs to the service; the allowance belongs to the test runner. A setup-file default puts it where every test file gets it, instead of in 46 fixtures. The module has no imports, so the setup file does not load the origin service into every test file.

## 4. Signal vs authority compliance

No new authority. The hold decision keeps its existing logic; only a default input changes, and only in a test process.

## 5. Interactions

- **Per-service `stageDeadlines` (previous change):** still wins over the process default. The budget tests set their own values or call the setter with `null`.
- **Module identity:** the setup file and the service import the same module in the same test-file context, so the default set in setup is the one the service reads. A test that resets modules gets a fresh copy with production budgets, which is the previous behaviour, not a wider one.
- **State between files:** each test file runs the setup file again; a file that changes the default does not affect another.
- **Production:** a source scan in `origin-stage-deadlines.test.ts` fails if anything under `src/` calls `setOriginStageDeadlineProcessDefaults`.
- **Spawn/kill:** none. Class `unbounded-self-action`: not applicable.

## 6. External surfaces

None at run time. Two new exports for tests (`setOriginStageDeadlineProcessDefaults`, `resolveOriginStageDeadline`); the moved names keep their old import path.

## 7. Multi-machine posture

Machine-local by design: an in-process default in a test runner. Nothing is stored or replicated.

## 8. Rollback cost

Revert the commit. No state, config or migration.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only, 2026-11-13.

Verdict: "Concur with the change". It checked every test that expects a recording hold in `tests/unit`, `tests/integration` and `tests/e2e` and found none outside the budget tests that relies on a stage timing out: each uses a rejecting mock, a throwing spool or a closed store, or is bounded by the store's own request deadline. No fake-timer test advances through a stage budget. No config changes isolation; no test resets modules around the origin service. No production path reaches the setter.

One should-fix, acted on: nothing pinned the budgets module's "no imports" property, which the setup file depends on. A test now reads the module and fails on any `import` or `require`. Its notes: the source scan covers `src/` only and `.ts/.tsx/.js/.mjs` files; a future test that resets modules and re-imports the service gets production budgets (the safe direction); services in a spawned server process keep production budgets; `allowSlowOriginRecording` in the test helper is now redundant with the default and is left in place.

**Reviewer concurred:** yes.
