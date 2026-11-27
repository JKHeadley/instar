# Not losing a finished fix

When a feedback worker finishes a fix, the server runs final checks before publishing it. To do that it moves the worker's folder to a review location. If the server restarts during that stage, the fix is marked to be checked again on the next run, which can be half an hour later.

We found a bug in that wait. If the machine's lease number changed in the meantime, the code decided whether to keep the attempt by looking in the old folder, which had already been moved. Finding nothing, it threw away a finished fix. That happened live to the first fix a worker completed in this run. The code now looks in the review location too.

This change also makes update restarts wait while an attempt is in setup or final checks, because those stages run inside the server and a restart loses them. A worker session that's merely running doesn't hold anything, because sessions survive restarts. Each hold lasts at most two hours, and the updater's existing limit, four hours by default, applies for each version. While a restart is waiting, no new attempts start, so holds can't chain together. A person can still force a restart.

This hold wouldn't have saved that particular fix, and it doesn't cover the server being restarted because it stopped responding. Nobody has a decision to make, and undoing this is a plain revert.
