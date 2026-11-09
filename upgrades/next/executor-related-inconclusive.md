# A slow related-tests check no longer discards a feedback fix

## What Changed
A feedback fix's last check runs every test related to the changed files, with a 45-minute limit. For core files that can be much of the suite, and on a busy machine it can run out of time with nothing failing. That failed the attempt and discarded the fix. A timeout in this one check, with no failure printed, is now inconclusive: the fix continues to a PR, the PR text says the run did not finish, and an audit event records it. A failing run, a failure printed before the timeout, and a run that floods its output still stop the fix, as does a timeout in any other check. CI's test jobs must still pass on the PR's head before merge; files CI's unit job excludes as flaky are then covered only after merge, where Local Verify runs.

## What to Tell Your User
A feedback fix that passed its own tests is no longer thrown away because a broad extra test run was slow. The CI tests still have to pass before it can merge.

## Summary of New Capabilities
- A related-tests timeout no longer discards a feedback fix.

## Evidence
Unit: tests/unit/feedback-factory/execute-service.test.ts covers both sides of the boundary. Live on Echo, 2026-11-07: attempt f27da149:a9 recorded outcome fixed, passed its base, head and lint checks, then failed "limit:command-wall-clock during the related-tests check".
