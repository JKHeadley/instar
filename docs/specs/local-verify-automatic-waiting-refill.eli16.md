# Requests keep their place and enter testing automatically

When the verification queue is full, the service already writes the pull request to a durable waiting list. Until now, somebody still had to offer that request again after a place opened. The saved place prevented some unfair overtaking, but it did not refill the queue by itself. An operator could therefore see a full waiting list while a newly available place remained unused between watcher passes.

This repair makes the existing coordinator offer a few waiting requests on its normal tick. It checks at most five requests in one pass and waits at least thirty seconds before another pass. The oldest live request goes first. A temporary GitHub read failure keeps that request's saved place, but gives it a two-minute retry pause so it cannot stop readable requests behind it. When that pause ends, its original age still determines its priority.

Every offer goes through the existing trusted-author, current-commit, current-base, saved-result and hold checks. Pending operator fronts and releases get their turn first. The service checks that main is healthy and that this machine still owns coordination after the asynchronous reads, before it inserts an entry. A saved request that became stale still needs a fresh offer from its owner or watcher, as before.

This does not increase how many tests run at once, change the queue's capacity, release a held change, or let a focused check authorize a merge. A pull request still needs its ordinary complete verification. The previous affected-test preflight stays switched off because its earlier selection trial did not produce useful test runs. Reverting this change returns waiting admission to the previous external-offer behavior; the existing waiting file remains readable.
