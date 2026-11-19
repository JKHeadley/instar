# Side-Effects Review — three load-sensitive tests wait for the real condition

**Version / slug:** `flaky-batch-1119`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Test files only. Three tests failed full merge-gate verify runs on a loaded host and passed alone. `tests/integration/cartographer-eventloop-worker.test.ts`: the two "does not starve the event loop" cases read the CPU time the test's own thread used between two turns of the loop (`process.threadCpuUsage`) where they read wall-clock timer lateness before; a new case checks the probe against a wait and against a 400 ms spin. `tests/e2e/session-management-e2e.test.ts`: the build-context respawn case and the slow-start case ask the spawn to return after the initial message is injected (`awaitInitialInjection`, an existing product option) where they polled the pane for 20 s, and the build-context case repeats the maintenance pass until the pane directory is recorded and asserts the recorded value. `tests/unit/job-portable-bundle.test.ts`: a module mock of `node:child_process` passes every call to the real `spawnSync` and replaces only the timeout of the portable file helper (1.8 to 3 s in product code) with 60 s. No file under `src/` changes.

## Decision-point inventory

No decision-point surface. No runtime code, gate, hook, route, config default or prompt is added, modified or removed.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

What each test stops catching, stated plainly:

- Event-loop cases: time the thread spends waiting without working (one slow synchronous disk call, or the processor being given to another process) is no longer counted. That is the load-dependent part. A change that holds the thread with work in one piece (detect parsed on the main thread, an unchunked walk or write pass, a one-call index serialize) reads the same as before. On a Node older than 23.9 the probe falls back to the old wall-clock reading.
- Session cases: a product that injects correctly but later than 20 s after the spawn no longer fails. The manager's own readiness budget (90 s fresh, 120 s resumed, plus a 15 s extension) is now the bound, and the per-test timeouts (150 s and 300 s) end a hang.
- Portable-job cases: nothing in the file asserted the helper's time limit, so nothing is lost. The limit itself stays as it is in product code and stays reported (fb-fe25893b-2ad).

---

## 3. Level-of-abstraction fit

Each repair sits in the test that had the fault and uses a seam that already exists: a Node API for thread CPU time, the product's `awaitInitialInjection` option and its test-only maintenance-tick binding, and vitest's module mock around a Node built-in. No new product seam was added.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

Tests only. The merge gate that runs them is unchanged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 250 ms bound in the event-loop cases is the existing bound, applied to a reading that does not depend on host load.

---

## 5. Interactions

- **Shadowing:** the `node:child_process` mock applies to the whole of `tests/unit/job-portable-bundle.test.ts`. It forwards every call unchanged except the timeout of calls whose command is `python3` and whose first argument ends in `job-portable-fs.py`. Checked by setting the replacement timeout to 1 ms: the helper-backed cases then fail with `spawnSync python3 ETIMEDOUT`, so the mock does reach the product's call and nothing else in the file depends on it.
- **Double-fire:** the build-context case now runs the maintenance pass more than once when the first pass records nothing. The live monitor runs the same pass every 5 s, and the store ignores a repeat with the same directories.
- **Races:** `awaitInitialInjection` makes the spawn call resolve after the injection; the mock session stays up for 10 s after it reads the message, and the pane is read at once.
- **Feedback loops:** none.

---

## 6. External surfaces

No external surface changes. No agent, user, external system or persistent state is touched. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: these are test files that run on whichever machine runs the suite and hold no state. No user-facing notices, no durable state, no URLs. No `/status`, `/health`, `/capabilities` or `/channels` answer is added or changed.

---

## 8. Rollback cost

Revert the commit. No persistent state, no migration, no agent repair, nothing user-visible.

---

## Conclusion

Clear to ship. The review produced one design choice worth naming: the portable-job cases keep the real python helper and only lift its time limit, because the "full-size owned file" case exists to prove the real round trip of a 256 KB file through the helper, and a faked helper would have removed that proof. One finding is passed on rather than fixed here: the helper's 1.8 to 3 s limits in `src/core/JobPortableFs.ts` are a product weakness on a loaded host (already reported, fb-fe25893b-2ad).

---

## Second-pass review (if required)

Not required (Tier 1, test files only).

---

## Evidence pointers

- Failure messages taken from the local verify run logs and flaky history, 2026-11-12 to 2026-11-19.
- Each changed file run alone five times in a row, then once more with eight busy-loop processes started when the run took its test slot: `tests/unit/job-portable-bundle.test.ts` 11 of 11 passed in all six runs; `tests/integration/cartographer-eventloop-worker.test.ts` 8 of 8 in all six; `tests/e2e/session-management-e2e.test.ts` 33 of 33 in all six.
- Event-loop probe readings (a temporary print, removed before the commit): detect case 3 to 4 ms of thread work per loop turn; population case 26 to 31 ms on a quiet run. Under the load run the population case read 31 ms of thread work while the old wall-clock reading in the same run was 160 ms.
- Portable-job mock checked by setting its replacement limit to 1 ms: the helper-backed cases then fail with `spawnSync python3 ETIMEDOUT`.
- `npx tsc --noEmit -p .` clean; the three test files type-checked separately with no error on a changed line.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
