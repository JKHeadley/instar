# Asking GitHub a second time before giving up on a merge (plain version)

Written 19 November 2026. It can be read with no other background.

> The one-line version: when a change has passed its tests and GitHub is not yet ready to merge it, the system now asks again for up to half a minute before moving on, where today it gives up at once and a person merges it by hand a minute later.

## The problem in one breath

Every change to Instar is tested on our own computers, and the moment it passes, the system tries to merge it, so that the next change is tested on top of it. One time in five that merge does not happen. In most of those cases nothing is wrong: GitHub had simply not finished working out whether the change can be merged, or its list of open changes was a few seconds behind. All 15 changes that got the answer "not mergeable" in the last three days were merged a little later, unchanged. About five times a day someone merges such a change by hand.

## What already exists

- **The hand-off:** right after a pass, the tester asks the merger to merge that exact change, and waits for the answer before starting the next test run.
- **The merger's own round:** every 10 minutes it looks at all open changes and merges any that are ready. So a missed change is picked up eventually, but late, and the next test run has already started without it.
- **All the safety checks** that decide whether a change may be merged. None of them changes.

## What this adds

When the only reason for not merging is that GitHub has not yet said whether the change can be merged, the merger waits a few seconds and asks GitHub about that one change again: after 5 seconds, then 10, then 15. At most three times, at most half a minute. As soon as GitHub says "yes, it can be merged", the merge goes ahead through all the usual checks. If GitHub says the change really conflicts, it stops at once.

It is not yet proven that "GitHub had not answered yet" is the cause in all those cases; the log did not record it. So the first step is to record GitHub's exact answer for a few days, and only then switch the waiting on.

## The safeguards

**Asking again is not merging.** The only thing that changes is that GitHub's answer is fresher. Every safety check runs as before, for the same change at the same version.

**It cannot hold the line long.** Half a minute at most, and only on hand-offs that would have failed anyway.

**It is off until the operator of the test line turns it on.**

## What it costs

On a hand-off that still fails, the test machine waits up to half a minute before its next run. Averaged over all hand-offs that is about three seconds. In rare cases a second change that passes in those same seconds has to wait for the merger's 10-minute round.

## What ships when

One small change, after review. Then seven days of counting: how many merges still need a hand, and whether the waits should be shorter or longer.
