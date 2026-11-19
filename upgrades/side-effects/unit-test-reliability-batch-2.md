# Side-Effects Review — unit test reliability, batch 2

**Version / slug:** `unit-test-reliability-batch-2`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `not required for a test-only change unless the gate asks`

## Summary of the change

Tier 1. Test files only: three files, about 77 lines added and 28 removed, nothing under `src/`. One commit attempt was planned and the review took one round. Five unit test files failed inside full parallel verify runs on the busier test machine and passed when run alone. Three of them had a cause inside the test and are repaired here. Two have a cause in product code and are left unchanged and reported to the operator.

Files changed:

- `tests/unit/autonomous-stop-hook-idle-backoff.test.ts`
- `tests/unit/telegram-origin/store-worker-recovery.test.ts`
- `tests/unit/telegram-origin/config-reader.test.ts`

### Per file

**`autonomous-stop-hook-idle-backoff.test.ts`**

- Observed: `MAX_SLEEP clamps the tier: expected 4419 / 4669 / 5059 to be less than 2500` and `a new inbound message for the topic breaks the sleep early: expected 5689 / 5797 / 8304 to be less than 3800`.
- Cause: both cases measured the wall time of the whole hook run. That time includes bash, jq and python start-up, which took several seconds on a loaded machine while the clamp and the early break both worked. The inbound-message case also wrote the message after a fixed 1.2 seconds, a guess at when the hook would be sleeping.
- Change: the clamp case now reads the sleeps the hook asked for, through the sleep probe the file already had, and requires exactly one 1-second sleep. The inbound-message case now waits (at most 10 seconds) for the hook to really start sleeping, then writes the message, and requires that the hook asked for fewer than 8 one-second sleeps out of the 8 the tier allows.
- Why it is not weaker: the old bounds allowed any sleep shorter than the bound. The new assertions pin the exact sleep the hook requested, so a clamp that slept 2 seconds, which the old 2.5 to 3.5 second bound could pass, now fails. The exit code and the recorded `lastSleepSecs` are still asserted.

**`telegram-origin/store-worker-recovery.test.ts`**

- Observed: in `a caller deadline answers only that caller`, `origin request deadline exceeded` on the re-read and on the admit that must resolve. In `queue wait behind a progressing worker is not a stall`, `expected { state: 'ready' ... } to match object { state: 'ready', generation: 1 ... }`, `expected null not to be null` after the 10-second wait, and `origin request deadline exceeded`. In `within the restart cap`, `origin request deadline exceeded`.
- Cause: timing chosen by the test left too little room. The first case waited a fixed 2 seconds for a 2.5-second injected stall and then gave real database work a 1-second deadline. The queue case injected 900 ms operations against a 1.5-second stall deadline, so one answer arriving 600 ms late made the watchdog replace the worker, which is the watchdog working as designed. The restart case treated one health call that ran out its 1-second deadline as a failure of recovery.
- Change: the first case uses a 3-second caller deadline with a 4.5-second stall and waits for the committed row itself (at most 10 seconds). The queue case uses five 900 ms operations against a 3.5-second stall deadline and requires the elapsed time to exceed that stall deadline. Its reads wait for the row (bounded). The restart case waits (at most 10 seconds) for a health transaction the worker served.
- Why it is not weaker: every assertion is kept. The stall still outlasts the caller deadline, the queue wait is still required to exceed the stall deadline, and generation, restart and report counts are checked as before, so a worker that was replaced still fails the case.

**`telegram-origin/config-reader.test.ts`**

- Observed: `origin-config-reader-timeout` in `fences a late stat ...` and in `keeps the revision through a timed-out read ...`, on reads that must succeed.
- Cause: the test waited a fixed 30 ms for the reader to release its single source slot after the blocked stat was let go. Until that slot is free the reader returns the previous attempt's promise, which is the timeout. Under load the release took longer than 30 ms. The 2-second budget was also short for a read that starts a worker on a loaded machine.
- Change: the test waits (at most 10 seconds) until the reader reports it is no longer busy, through its public health reading. The budget for reads is 5 seconds and the two cases have a 40-second limit, since each waits out one budget on purpose.
- Why it is not weaker: the counts of stats, byte reads and workers, the revision checks and the invalidation checks are unchanged. The "no late worker" check now runs after the source has really settled, which is the moment the case is about.

**`job-portable-bundle.test.ts` — left unchanged, product cause.** Observed `portable-filesystem-refused: spawnSync python3 ETIMEDOUT` (8 times) and the file holding the new bytes after the failed journal commit (twice). `src/core/JobPortableFs.ts` gives each python helper call 3 seconds. Under load the call ran out of time. When the write that times out is the restore write, the rollback is recorded as incomplete and the new bytes stay in place. Nothing in the test can lengthen that.

**`usage-limit-key-pickup.test.ts` — left unchanged, product cause.** Observed `expected undefined to be '/Users/.../.claude'` (5 times, always the first call whose failure is visible). `SessionManager.configHomeForSession` gives the tmux call 2 seconds and returns nothing on any failure other than "unknown variable". The test cannot tell a timeout from another failure because the reason is discarded.

## Decision-point inventory

No decision-point surface. The change touches test files only.

---

## 1. Over-block

No block/allow surface, so over-block is not applicable. In test terms: none of the changed cases now fails on behaviour it used to accept as correct, except a clamp that sleeps longer than one second, which is the defect that case exists to catch.

---

## 2. Under-block

No block/allow surface, so under-block is not applicable. In test terms: the two idle-backoff cases no longer bound the wall time of the hook run, so a hook whose start-up became very slow would not fail there. That was never what those cases were for, and the 120-second test limit still applies.

---

## 3. Level-of-abstraction fit

The repair is in the tests, which is where the cause was for these three files. For the two files whose cause is a product time limit, the right layer is the product code, so they are reported and not changed here.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Tests only. No runtime check, gate or detector is added or changed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none. No runtime checks are involved.
- **Double-fire:** none.
- **Races:** the changes remove races between the test and the code under test. Each case still uses its own temporary directory.
- **Feedback loops:** none.

The shared helpers under `tests/helpers/` and the vitest configuration are not changed. Run time grows by about 2 seconds for the store case, 2 seconds for the queue case and 6 seconds for the config reader file.

---

## 6. External surfaces

No external surface changes. No agent, user, external system or persistent state is touched. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: these are unit tests that run on whichever machine runs the suite, with temporary directories on that machine. They emit no user-facing notices, hold no durable state and generate no URLs. No status surface is added or changed.

---

## 8. Rollback cost

Revert the commit. No persistent state, no migration, no agent repair and nothing a user can see.

---

## Conclusion

Three load-sensitive unit test files now wait for the real condition with a finite bound in place of a fixed short wait or a wall-clock bound. No assertion was removed, no case is skipped and no whole-test retry was added. Two files are unchanged because their cause is a time limit in product code, and that evidence goes to the operator. Clear to ship.

---

## Second-pass review

**Reviewer:** not required for a test-only change unless the gate asks.

---

## Evidence pointers

- Failure messages: `run-detail` rows in the local verify audit log, 2026-11-02 to 2026-11-18.
- The three changed files run together three times: 27 of 27 tests passed each time.
- All five target files in one command: 54 of 54 passed.
- The three changed files with two heavy unit files, twice with different pairs: 294 of 294 and 396 of 396 passed.
- `tsc --noEmit -p .` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
