# Side-Effects Review — telegram-origin store request deadline: a suite-wide test default

**Version / slug:** `telegram-origin-store-deadline-test-default`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent read-only sweep (see the end)`

## Summary of the change

Tier 1. `OriginStore`'s default request deadline resolves through a new `resolveOriginStoreRequestTimeout(own?)` in the import-free `OriginStageDeadlines.ts`, which also adds `setOriginStoreRequestTimeoutProcessDefault(ms | null)`. `tests/vitest-setup.ts` sets 20 000 ms. Two source files, the setup file, one helper comment, one new test file.

Why: the 2 s deadline is the layer under the stage budgets lifted by PRs 3149 and 3153; a loaded worker outlasting it failed three unrelated changes in one afternoon.

## Decision-point inventory

`OriginStore` decides a request has failed when the deadline passes; `TelegramOriginService` then holds the send. In production both are unchanged (same constant, setter never called). In a test process the default wait before that decision rises to 20 s for stores opened without their own option.

---

## 1. Over-block

None added. An explicit `requestTimeoutMs` is passed through untouched and validated by the store as before.

## 2. Under-block

In tests only: a slow but working worker is waited for up to 20 s. A dead, closed or failed-to-start worker still rejects at once. A truly hung worker on a default-built store fails its test at 20 s instead of 2 s; the stall watchdog (default `max(30 s, deadline)`) is unchanged.

## 3. Level-of-abstraction fit

Same seam and same module as the stage budgets; the module stays import-free so the setup file can load it before any test's mocks apply (pinned by an existing test).

## 4. Signal vs authority compliance

No new authority; a default input changes in a test process only.

## 5. Interactions

- **Stage budgets (20 s):** a stage now gives up at 20 s by its own budget or the store's deadline, whichever comes first; before, the store's 2 s always came first.
- **Stall watchdog:** validation requires stall ≥ deadline; default stall is `max(30 000, deadline)`, satisfied at 20 000. No test passes `stallTimeoutMs` without `requestTimeoutMs`.
- **Child processes:** a store opened in a process a test spawns keeps 2 s (the setup file does not run there).
- **Spawn/kill:** none. Class `unbounded-self-action`: not applicable.

## 6. External surfaces

None at run time. Three new exports for tests.

## 7. Multi-machine posture

Machine-local by design: an in-process default in a test runner.

## 8. Rollback cost

Revert the commit. No state, config or migration.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only sweep, 2026-11-13, run before the code was written, on the question that decides safety: does any test depend on the default 2 s deadline firing.

Result: none. Every test that stalls a worker (`store-worker-recovery`, `telegram-origin-worker-recovery`) pins its own `requestTimeoutMs` (200 to 2000 ms); every other failure path rejects at once (closed or killed worker, failed start, corrupt file, mocked rejection); no test expects the deadline's message, stops a worker with a signal, or mocks a store method to never resolve; no test passes `stallTimeoutMs` alone. `TelegramOriginRuntime`, `bootTelegramOrigin` and the test probe pass no deadline, so the default reaches boot-built stores, which the per-fixture helper cannot. No production code mirrors the 2 s value. It listed three stale comments; the two in test support files are updated here.

**Reviewer concurred:** yes (verdict "safe as is"). The implementation was written after that read and follows the pattern it named; its own tests avoid timing (they read the latched value) so they cannot add a flake.
