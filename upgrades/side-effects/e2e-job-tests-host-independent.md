# Side-Effects Review — two e2e job tests no longer depend on the host's memory or the wall clock

**Version / slug:** `e2e-job-tests-host-independent`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, tests only. 2 test files (about 70 changed lines) plus this artifact, an ELI16 and an internal-only release note. Effort: no spec, one build pass by a builder subagent (which ran each fixed file six times), diff reviewed by the author.

`tests/e2e/job-launch-lifecycle.test.ts` pins the scheduler memory gate's limits through the agent's own `state/memory-thresholds.json` (loaded by `MemoryPressureMonitor` at boot), so the real host's memory reading no longer decides whether the file's triggers are admitted, and adds a last test that closes the gate (`PATCH /monitoring/memory/thresholds` with limits of 0) and asserts the refusal. `tests/e2e/job-cost-lifecycle.test.ts` stops calling `start()` on a scheduler that holds the 26 built-in jobs, because `start()` arms real wall-clock crons whose ticks changed the session counts the test asserts.

Cause, proven for the first file and inferred for the second: on 2026-11-16 four Local Verify runs on a Mac Studio at 78 to 83% memory use failed these files for unrelated changes (PRs 3212, 3206, 3213), while the same heads passed on a second machine.

## Decision-point inventory

No product decision point is changed. The memory gate (`src/commands/server.ts`, "Wire memory gate into scheduler"; `MemoryPressureMonitor.canSpawnSession`) is exercised, not modified.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Test coverage view: the first file previously proved the admit side only by luck of the host; it now proves both sides deterministically. The second file no longer runs its scenario under a started scheduler. That scenario asserts what `triggerJob` does (no-model scripts run with zero sessions, later conversions stay on sessions); it never asserted anything about cron firing, and cron arming is covered by the scheduler's own tests. What is lost is incidental coverage of "a started scheduler does not break direct triggers", which was the source of the flake.

---

## 3. Level-of-abstraction fit

Right layer. The defects are in the tests' assumptions about their host (free memory) and about time (no cron tick during the test). The first fix uses an existing product seam (the thresholds file and route) rather than adding a test-only backdoor.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Tests only.

## 4b. Judgment-point check (Judgment Within Floors standard)

No heuristic added at any decision point.

---

## 5. Interactions

- The gate-closed test is the last test in its file and leaves the gate closed, so the retry the scheduler books for the refused job cannot start a session during teardown. Its job slug contains the main slug, so the file's existing tmux cleanup covers it.
- The thresholds file is written in the test's own temporary agent home; nothing on the real machine is touched.
- No other test file is changed. The builder's list of other e2e and integration files that boot a real scheduler without pinning memory is in its report; they are not changed here; the list is filed in the feedback queue as fb-5fc4f2ce-2f7.

---

## 6. External surfaces

None. No operator surface touched (6b not applicable).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: these are tests, and the point of the change is that their result must not differ by machine. No notices, durable state, URLs or status surfaces.

---

## 8. Rollback cost

Revert the two test files. No persistent state, nothing user-visible.

---

## Conclusion

Removes two host-dependent wrongful failures from the verify line without touching product code, and turns an accidental check of the memory gate into a deliberate two-sided one. Found and not changed: `monitoring.memoryMonitoring: false` is not read where the memory gate is wired, so the setting does not turn the gate off; filed to the feedback queue as fb-343e3668-4d5. Clear to ship.

---

## Second-pass review (if required)

Not required: tests only, no decision point changed.

---

## Evidence pointers

- Unmodified `job-launch-lifecycle`: 3 of 5 failed with `Job admission refused by live scheduler` at 83% host memory use (Instar's own reading).
- Fixed files: 3 of 3 each at 83% and 3 of 3 each at 61%.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
