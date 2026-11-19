<!-- internal-only -->

# Unit test reliability, batch 2

## What Changed

Three unit test files that failed under a full parallel run on a loaded machine, and passed alone, now wait for the real condition with a finite bound. Test files only; no runtime code changed.

- `tests/unit/autonomous-stop-hook-idle-backoff.test.ts`: the clamp case and the inbound-message case read the sleeps the hook asked for; they no longer bound the wall time of the whole hook run. The inbound-message case waits for the hook to start sleeping before it writes the message.
- `tests/unit/telegram-origin/store-worker-recovery.test.ts`: the slow-disk case waits for the committed row; the queue case leaves one operation 2.6 seconds of slack against the stall deadline, up from 600 ms; the restart case waits for a served health transaction.
- `tests/unit/telegram-origin/config-reader.test.ts`: the test waits until the reader has released its source slot; reads that must succeed have a 5-second budget.

`tests/unit/job-portable-bundle.test.ts` and `tests/unit/usage-limit-key-pickup.test.ts` are unchanged: their failures come from 3-second and 2-second child-process time limits in product code.

## Evidence

- Failure messages taken from the local verify audit log, 2026-11-02 to 2026-11-18.
- The three changed files run together three times: 27 of 27 tests passed each time.
- All five target files in one command: 54 of 54 passed.
- The three changed files alongside two heavy unit files, twice with different pairs: 294 of 294 and 396 of 396 passed.
- `tsc --noEmit -p .` clean.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
