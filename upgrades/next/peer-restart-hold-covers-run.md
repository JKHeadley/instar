<!-- bump: patch -->
## What Changed

A planned server restart (for an update or maintenance) waits for a test run that the coordinator has handed to a helper machine. That wait was bounded at 21 minutes from hand-out, a figure measured when helper runs took about 13 minutes. Runs now take 22 to 25 minutes, so the wait expired a minute or two before the result was collected, the restart went ahead, and the nearly finished run was abandoned (2026-11-15, PR 3198: 22 helper-minutes lost; 37 of 38 passing helper runs that day were longer than 21 minutes).

- `PEER_RESTART_HOLD_MS` is now 61 minutes: the helper run ceiling (`PEER_LIMITS.maxRunMs`, 60 minutes) plus one poll to collect the result. The supervisor, the foreground restart watcher, the updater's restart holds and the audit trail all read this one constant.
- The normal wait is unchanged: the hold ends when the run is collected. Only the worst case moves (a helper that answers polls but never finishes: up to 61 minutes instead of 21). A quiet helper (two polls), a stale heartbeat (90 seconds), the three-hour request ceiling, the updater's four-hour ceiling and `forceRestart` all behave as before.
- A unit test keeps the bound at or above `PEER_LIMITS.maxRunMs + PEER_LIMITS.pollMs`, so it cannot fall behind real run length again.

## What to Tell Your User

Nothing changes for people who run one machine. If your agent tests its own changes on a second machine, an update that arrives during a test now waits for that test to finish instead of cutting it off a minute early, so tests are no longer thrown away and repeated.

## Summary of New Capabilities

- No new routes or settings. One timing bound corrected.

## Evidence

- Unit: `tests/unit/planned-restart-verify-guard.test.ts` (a run 22, 25, 40 and 59 minutes old with a fresh heartbeat holds; a run at the bound does not; a 22-minute-old run with a stale heartbeat does not; the bound is at least the helper run ceiling plus one poll; the merge-in-progress combination still takes the later bound). `tests/unit/localVerify/peerVerifier.test.ts` still green (75 tests).
- Incident analysis: the coordinator's own logs for 2026-11-15 show the hold logged at 21:23:54Z and 21:34:54Z for an attempt bound at 21:43:24Z, the server still working until 21:43:30Z, and the restart consumed between 21:43:29Z and 21:43:34Z.
