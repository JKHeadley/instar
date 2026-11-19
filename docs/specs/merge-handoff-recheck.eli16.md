# Asking GitHub a second time before giving up on a merge (plain version)

Written 19 November 2026. It can be read with no other background.

> The one-line version: when a change has passed its tests and GitHub is not yet ready to merge it, the system now asks again for up to a minute before moving on, where today it gives up at once and a person merges it by hand a minute later.

## The problem in one breath

Every change to Instar is tested on our own computers, and the moment it passes, the system tries to merge it, so that the next change is tested on top of it. One time in five that merge does not happen. In most of those cases nothing is wrong: GitHub had simply not finished working out whether the change can be merged, or its list of open changes was a few seconds behind. All 15 changes that got the answer "not mergeable" in the last three days were merged a little later, unchanged. About five times a day someone merges such a change by hand.

## What already exists

- **The hand-off:** right after a pass, the tester asks the merger to merge that exact change, and waits for the answer before starting the next test run.
- **The merger's own round:** every 10 minutes it looks at all open changes and merges any that are ready. So a missed change is picked up eventually, but late, and the next test run has already started without it.
- **All the safety checks** that decide whether a change may be merged. None of them changes.

## What this adds

When the answer is one of three that mean "GitHub was not ready" (it has not yet said whether the change can be merged; the change was missing from the list just read; the list could not be read), the tester asks again: after 10 seconds, then 20, then 30. At most three more times, at most one minute. The first time it merges, or gets a real refusal, it stops.

## The safeguards

**Asking again is not merging.** Every time, the merger runs all of its checks from the start, for the same change at the same version. A change that really conflicts gets the answer "conflicting" and is never asked about again.

**It cannot hold the line long.** One minute at most, and only on the hand-offs that would have failed anyway.

**It is off until the operator of the test line turns it on.**

## What it costs

On a hand-off that still fails, the test machine waits up to a minute before its next run. Averaged over all hand-offs that is a few seconds.

## What ships when

One small change, after review. Then seven days of counting: how many merges still need a hand, and whether the waits should be shorter or longer.
