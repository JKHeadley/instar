# Side-Effects Review — pre-push smoke VERIFY gets its own exit code

**Version / slug:** `smoke-verify-exit-code`
**Date:** `2026-11-27`
**Author:** `Dawn`
**Second-pass reviewer:** `not required (see section 4: no block/allow decision changes)`

## Summary of the change

`scripts/pre-push-smoke.mjs` printed `PRE_PUSH_SMOKE_RESULT=VERIFY reason=affected-set-indeterminate tests_run=0` and exited 1 when the affected-test listing could not be used (for example it timed out). `.husky/pre-push` treats every non-zero exit the same way and printed "Tests failed after smoke runner retry". A session read that as a hidden failing test and spent its time hunting for one.

Fix: VERIFY now exits 3 (`VERIFY_EXIT_CODE`). Any other path that would exit 3 (vitest or the listing run itself) is mapped to 1 by `failureExit`, so 3 only ever means VERIFY. The hook records the test command's exit code and, in smoke mode, prints "Push blocked: local smoke NOT VERIFIED — affected test set indeterminate, 0 tests ran (no test failed)" for code 3. The "retrying once" line is now printed only when another attempt actually follows (`attempt -lt MAX_ATTEMPTS`); smoke mode runs one attempt.

## Decision-point inventory

- Push allowed/blocked: unchanged. Every non-zero exit still blocks the push, exactly as before.
- Operator message on a blocked push: changed for the VERIFY case only.

## 1. Over-block

None. No input that was allowed before is blocked now: exit 0 still passes, and the mapping only changes which non-zero code is returned.

## 2. Under-block

None. Exit 3 is non-zero, so `if $TEST_CMD` still fails and `TESTS_OK` stays 0. A genuine failure that exited 3 is remapped to 1, which still blocks.

## 3. Level-of-abstraction fit

The runner is the only component that knows zero tests ran, so it is the right place to encode that in the exit code. The hook only translates the code into a message.

## 4. Signal vs authority compliance

No authority added or removed. This is a message-accuracy fix on an existing block, so the second-pass reviewer requirement for gate changes does not apply: the gate's decision is byte-for-byte the same for every input.

## 5. Interactions

Callers that only test for zero/non-zero (CI, other scripts) are unaffected. No caller in the repo matches on exit code 1 specifically from this script.

## 6. External surfaces

Developer-facing terminal output only. No agent, user, or fleet behaviour changes.

## 7. Rollback cost

A plain revert restores the old exit code and message. No state, migration, or config.

## Evidence

The hook's test block was run under `sh` with stub exits 3, 1 and 0 in both retry modes; all six combinations printed the right message, and exit 0 passed. The real script was run with a fake `npx`: a listing killed by SIGTERM exits 3 with VERIFY, and a listing that itself exits 3 now exits 1.
