# Upgrade Guide — Local Verify suite-slot priority

<!-- bump: minor -->

## What Changed

A full Local Verify queue could start no runs while other sessions repeatedly took the Studio's one full-suite test slot. Local Verify now reserves the next slot while a queued entry waits for a current holder. Its child releases that reservation during install, build, and lint, then reserves the slot again when the test lanes are ready. The reservation renews while waiting and expires within two minutes if its owner stalls. Targeted tests retain their separate lane.

The host test limiter continues to enforce its one-suite cap and fail-open behavior on uncertain state. Existing worktrees must update to a revision with this change before their test runners honor the priority reservation. Under a sustained merge backlog, an ordinary full suite may reach its existing 45-minute slot wait limit.

## What to Tell Your User

Queued merge verification now gets the next full-test slot when it is ready to run. Other full suites may wait while a merge verification is seeking that slot; small targeted tests continue separately. The status page shows when merge priority is active.

## Summary of New Capabilities

- `GET /test-runner-limiter` adds `mergeGatePriority.active`.
- Local Verify publishes short host-local priority claims while waiting to start, and its child publishes one while seeking the test slot. Dead, expired, corrupt, and foreign-host claims have no authority.
- Claims are machine-local in `~/.instar/host-test-runner-priority/` and capped at 64 per-agent keys.

## Evidence

- Before: `.instar/state/local-verify/runs/ff28d073242750b541347c3acb49c5e8.log` recorded an overlap instead of a run; the queue started no real verify for nearly three hours while ad-hoc suites held the slot.
- Build and lint pass; 213 focused unit tests pass, including ordinary-suite yield, priority acquisition, claim expiry, coordinator release during child preparation, and child claim cleanup.
- Integration and E2E route/lifecycle tests are included in the full suite run for this change.
