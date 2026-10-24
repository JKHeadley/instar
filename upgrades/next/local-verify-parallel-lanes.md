## What Changed

- **The local merge check runs its test groups at once.** The server-side check that merges wait on ran unit, integration and end-to-end tests one after another (about 4 + 15 + 23 minutes), one PR at a time, so a handful of open PRs meant hours of waiting. It now takes one host test slot and runs all groups inside it at the same time, with the end-to-end group split into two halves. Each test process gets its own temp folder and tmux server. About 20 minutes instead of 42 on the Mac Studio. The host still runs one full check at a time, and the unit group is held to 4 workers (7 test workers in total).
- A file reported by both halves, a missing report, or any half's error exit fails the check; the slot is released only after every test process has exited.

## What to Tell Your User

Nothing to do. PRs that wait on the local merge check now wait about half as long.

## Summary of New Capabilities

- None user-facing. `LOCAL_VERIFY_LIMITS.e2eShards` and `unitWorkersParallel` set the shard count and unit workers (in the verifier's policy hash).

## Evidence

- `tests/unit/localVerify/orchestrator.test.ts` (held slot, busy slot re-queue, shard merge rules, sibling-shard exit before release, unit worker pin)
- `tests/unit/localVerify/suiteSlotSeam.test.ts` (the real host bound: one held slot, recognised as the parent of a lane process)
- Measured on the Studio on main 70dce25: lanes ~20 min vs ~42 serial; 58,373 tests, one load-sensitive test (fixed in PR 2319).
