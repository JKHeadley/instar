<!-- bump: patch -->
## What Changed

Local Verify's integration-test lane may now run for 45 minutes instead of 30, matching the end-to-end lane (`LOCAL_VERIFY_DEADLINES.lanes.integration`, `src/localVerify/policy.ts`). On a busy verifier whose integration lane runs as a single process, the lane was taking 30–42 minutes and every pull request ended `error:deadline:integration` with no failing test. Every test still runs, any failure still fails the check, and the overall 120-minute active-work deadline is unchanged. The policy hash changes, so a peer verifier on an older build has its records refused until it updates (the existing version-skew rule).

## What to Tell Your User

The local check that runs before a change merges was timing out on busy days even when every test passed. Its integration tests now get 45 minutes instead of 30, so changes stop failing just because the machine was busy. Nothing is skipped.

## Summary of New Capabilities

- Local Verify integration lane deadline: 45 minutes (was 30).

## Evidence

- Unit: `tests/unit/localVerify/orchestrator.test.ts` (the integration-lane deadline case is derived from the constant and still ends `deadline:integration-1` one millisecond past it), and the rest of `tests/unit/localVerify/`.
