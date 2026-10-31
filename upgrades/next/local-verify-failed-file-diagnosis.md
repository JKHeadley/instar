# Advisory cross-machine diagnosis for failed PR tests

<!-- bump: minor -->

## What Changed

Local Verify can ask one idle peer to rerun one to three failed test files on the exact PR merge and the exact base commit. The comparison is limited to one attempt and 15 minutes and is preempted by a full PR verification. It ships off. The peer result is an advisory observation beside the original red record; it cannot clear the failure, alter main health, or authorize a merge.

## What to Tell Your User

For a failed PR with named test files, I can check whether those files fail on another machine and on the unchanged base. I will show the exact commits and raw observations alongside any suggested explanation. A green peer rerun is still not a passing PR verification.

## Summary of New Capabilities

Optional `off|observe|auto` failed-file diagnosis with an exact-record API projection and separate peer routes. Observe measures eligible cases without starting peer work.

## Evidence

The approved spec and PR review packet contain the unit, authenticated HTTP integration, production lifecycle and full-suite results. Isolated-agent rehearsal and the Echo observe window are required before auto is enabled.
