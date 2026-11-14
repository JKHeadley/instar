# Side-Effects Review: lifecycle e2e Phase 6 ends its own sessions before the manual trigger

**Version / slug:** `lifecycle-e2e-lastrun`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (test-only, no decision point)`

## Summary of the change

Tier 1: test-only, one file (`tests/e2e/lifecycle.test.ts`), about 25 lines, first commit attempt, no review rounds beyond this one. A revert fully undoes it.

The failure: `tests/e2e/lifecycle.test.ts:425` (`jobState.lastRun` undefined for `e2e-health`), seen on PR #2804's Mini local verify and in PR #2806's GitHub Actions job 127321800225, and 4 times in the local-verify flaky history since 11-04. Phase 6 (manual trigger) shares the fixture's 3-session budget with Phase 5's two API sessions and an every-second cron job, and tried to wait them out with a 5 s drain. When the mock's "Session ended" line is missed under load, a session counts as running until the 15 s startup grace. Two outcomes follow:
- CI shape (seen in the CI log: "exited on its own after 15s"): the 5 s drain times out, the manual trigger never runs, and Phase 10 fails as a knock-on.
- Mini shape (from the code; not reproduced locally): the drain passes, but Phase 5's sessions plus a cron spawn already in flight fill the 3-session cap. The spawn is refused with `SessionCapacityRefusedError` and re-queued as a capacity wait after the API already returned "triggered". Phase 9 then pauses the scheduler, so the run never happens and `lastRun` is never written.

The fix: Phase 6 kills every session this fixture still has running (it already paused the scheduler), then triggers. It then waits for the manual run's own `lastRun` and its `job_triggered` event, so a failure now points at Phase 6 instead of Phase 10. No timeout lengthened, no retry, no skip, no assertion loosened. One new 5 s wait, on a condition that the mock spawn meets within milliseconds.

Before/after, same machine, file run alone as a unit-lane copy with the mock's sleep raised to emulate slow-ending sessions: old version 2/2 failed (Phase 6 drain timeout + line 425, the CI shape). Old version under forced high memory pressure and 6 s sessions: 1 failed (Phase 7, same contention). New version: 10/10 passed across 2 slow, 2 slow+pressure, 2 mildly slow and 4 plain runs. Unstressed old version: 3/3 passed (the flake needs load).

## Decision-point inventory

None. Test fixture only.

## 1. Over-block

No issue identified: no runtime surface.

## 2. Under-block

The product behaviour that made the Mini shape silent remains: `POST /jobs/:slug/trigger` returns "triggered" before the spawn settles, and a capacity refusal re-queues it. That is the designed capacity wait (#2700). It is reported to the hub as an observation and not changed here.

## 3. Level-of-abstraction fit

The defect is the fixture's isolation, so the fix sits in the fixture.

## 4. Signal vs authority compliance

- [x] No decision point touched.

## 5. Interactions

Killing Phase 5's sessions early affects nothing later: Phase 9 spawns its own session, and Phase 10 only needs session files on disk, which killed sessions keep. A cron spawn still in flight can land after the kill; one cron session plus the manual run fits both 2 job slots and the 3-session cap.

## 6. External surfaces

None.

## 7. Multi-machine posture

Not applicable (test fixture).

## 8. Rollback cost

Revert the commit.
