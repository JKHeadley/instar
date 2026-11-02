# Green pull requests no longer wait behind one that gave up

When one of the agent's code changes passes all its checks, a background watcher merges it. It looks at all the changes that are ready, picks the oldest, and tries to merge that one; on its next round it picks the oldest again, and so on. That is fair, as long as the oldest one can actually be merged.

The problem: a change can end up in a "gave up" state, for example after its description failed a required check three times. The watcher then stops trying it, which is right. But it was still the oldest change on the list, so every round the watcher picked it, saw that it had given up on it, and stopped for that round without looking further. Every newer change that was ready waited behind it, for as long as that old change looked mergeable. Today that held a fix that had already passed all its tests for about 36 minutes.

Now, when the oldest change is one the watcher has given up on (or is waiting before retrying), the watcher notes that and moves on to the next-oldest one in the same round. It still makes at most one merge attempt per round, and a change it has given up on is still never merged automatically; it just no longer holds up the others.
