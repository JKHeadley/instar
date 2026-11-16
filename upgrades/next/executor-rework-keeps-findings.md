<!-- bump: patch -->
## What Changed

The feedback executor's rework path now passes the previous independent-review findings to the next attempt even when an attempt in between stopped before publishing. `writePreviousReview` used to read only the immediately previous attempt, so a rework that stopped on reroute capacity, a lost lease or a restart made the following attempt start without the findings. It now reads the latest earlier attempt that published a PR; the rest of the rule (that attempt must be closed as `review-failed-closed` with stored findings) is unchanged.

## What to Tell Your User

When an automatic fix is turned down by its safety review, the next try now always starts from the reviewers' notes, even if a try in between never got going.

## Summary of New Capabilities

None. This is a fix to the existing feedback executor.

## Evidence

Live: item feedback-17ab2960 (PR 3199 closed after failing review, 2026-11-16 19:08Z) started rework attempt a2, which stopped on reroute-capacity at 19:18Z; the next attempt would have run without the findings. Item feedback-e588a2a1 lost PR 2442's findings across attempts a4–a11 the same way. New unit test: a rework attempt refused a slot (RerouteRefusedError) is followed by an attempt whose workspace holds the findings file from PR 100 (previousAttempt 1) and whose prompt names it; the 17 existing review-failed-recovery tests pass unchanged.
