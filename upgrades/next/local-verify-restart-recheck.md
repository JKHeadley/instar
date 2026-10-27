# Local Verify: a waiting update restarts as soon as the verify it waited for ends

## What Changed

- `src/core/AutoUpdater.ts`: `recheckRestartHolds()` retries a restart deferred on a `local-verify:*` hold after 1 s once no restart hold is active, instead of at the next 5-minute re-check. The full restart gate still runs.
- `src/localVerify/LocalVerifyService.ts` + `localVerifyWiring.ts`: the service calls it once each time a verify run ends.

## What to Tell Your User

Nothing changes for an ordinary agent. For maintainers who run Local Verify: when an Instar update arrives during a pull request test run, the server now restarts right after the run ends instead of up to five minutes later, so the test line is idle for less time.

## Summary of New Capabilities

None — internal timing fix.

## Evidence

Audit log 2026-10-20..26: 35 update pauses of the verify line, 3.3 h total, 5.7 min average. Unit: `AutoUpdater-restart-holds.test.ts` (ends a local-verify hold → restart within 3 s; still-active hold and non-local-verify deferral → untouched); `LocalVerifyService.test.ts` through the real AutoUpdater (a verify ending releases the deferred restart at once, nothing new starts meanwhile).
