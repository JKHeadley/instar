# Side-Effects Review — watchdog CPU-progress test waits for its reading

**Version / slug:** `watchdog-cpu-test-under-load`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent, concurred (see Second-pass review)`

## Summary of the change

`tests/integration/session-watchdog-safe-wait.test.ts`, the real-process-table case: the fixed `delay(1_500)` before the second `ps` reading is replaced by a poll (every 250 ms, up to 10 s) until the burner's CPU delta exceeds `MIN_PROGRESS_CPU_DELTA_MS`, imported from the production module. The assertions after it are unchanged.

Found by running the test lanes in parallel on the Studio (local-verify throughput work): the burner got under one core and accrued < 1 s CPU in 1.5 s wall time, so the tracker answered `idle`.

## Decision-point inventory

None. Test-only; no production code changes.

## 1. Over-block
None: no production behaviour changes.

## 2. Under-block
The test still asserts the production bound (`> MIN_PROGRESS_CPU_DELTA_MS`) through the real tracker. If `ps` stopped advancing, the poll ends at 10 s and the same assertions fail as before. The test timeout stays 20 s, which covers the 5 s appear-wait plus the 10 s poll.

## 3. Level-of-abstraction fit
The fix is in the test, where the wrong timing assumption was. Production code was right.

## 4. Signal vs authority compliance
Not applicable (no gate or check changes).

## 5. Interactions
None. Measured: under 24 spinning processes on 16 cores, the old file failed 1/19 and the new file passed 19/19; alone both pass.

## 6. Rollback
Revert the commit.

## Second-pass review

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), one round, 2026-10-23 — concur

Concur, no blocking issues. The poll waits for a delta strictly above the production `MIN_PROGRESS_CPU_DELTA_MS` (the tracker counts ≥, so the test bar is unchanged or slightly stricter); the wait is bounded (5 s to appear + 10 s polling) inside the 20 s burner life and test timeout; cleanup unchanged. Integration file 19/19. Nit left: under very heavy load slow `ps` calls could approach the 20 s timeout, which fails loudly, never passes falsely.
