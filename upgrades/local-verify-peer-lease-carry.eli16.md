# Test runs on a second machine survive a restart of the main machine

Before a change can merge, Instar's Local Verify runs the full test suite. The machine that holds the "serving lease" (the coordinator, usually the Mac Studio) can hand one run at a time to a second machine, a "peer" such as the M5. That roughly doubles how many changes get checked per hour.

There was a safety rule that a peer's result only counts if the coordinator still holds the lease under the same number it had when it handed the run out. The rule exists so a machine that lost the lease cannot import results it no longer owns. The catch is that every time the Studio's server restarts, it takes the lease back under the next number, even when no other machine ever had it. The old rule treated that as "someone else took over": it threw the M5's run away and told the M5 to stop. On the night of 10–11 November that happened 12 times, and almost none of the M5's work counted.

What changes:

1. If the coordinator holds exactly the next lease number, no other machine can have held the lease in between, because every takeover uses up a number. So the run is kept, and its result is imported when it finishes.
2. While the coordinator is still starting up and does not hold the lease yet, it waits instead of cancelling. It never imports anything until it holds the lease again. If another machine is named as the holder, or the wait runs longer than the normal run limit, the run is dropped as before.
3. When the coordinator itself is too busy for heavy work, it now offers the next queued run to a free peer instead of starting it locally. A run is never held back more than 10 minutes, and the main-branch check always runs on the coordinator.

The safety checks on what gets imported stay the same: the same change, the same base, the same test code and policy, and the same coordinator.
