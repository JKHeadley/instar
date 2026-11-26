# The helper machine keeps working while the main machine restarts (plain version)

Two computers test every change before it merges. The Studio is in charge; the M5 helps.

When the Studio needs to restart for an update, it first waits for its own test run to finish. Today, while it waits, it also stops handing work to the M5, so the M5 sits idle even with dozens of changes waiting. When the Studio comes back, it counts as a new "boss" and throws away whatever the M5 was in the middle of, even though that work is still good.

The fix has three parts:

All three parts sit behind one on/off switch that starts off. It is tried first on a throwaway test pair, then on our own two machines, and only then switched on everywhere. The switch also works as an emergency off.

1. **While the Studio waits to restart, it can still hand work to the M5.**
2. **Work handed out during that wait does not hold up the restart.** The one exception: if the M5 finishes a passing test just before the restart, the Studio still takes up to 10 minutes to merge that change rather than lose it.
3. **After a restart, the Studio keeps the M5's work** if no other machine was in charge in between and the change being tested has not moved. If another machine was in charge even briefly, the work is thrown away as today. That way a result only counts if the machine in charge asked for it without a break.

The first review round caught a mistake. My first version trusted a signal that resets on every restart, so it could not tell whether another machine had been in charge. The fix uses a record the security work (PR 3451) already keeps on disk.

**Expected gain:** about 105 M5-minutes a day. That is about 4 to 5 more test runs, or about 2 more merges a day. It is smaller than my first figure because some restarts change the test tooling itself, and the M5 sometimes pauses for its own update.

**How we will know:** over at least 10 restarts where work was waiting, M5 idle time per restart drops from about 8 minutes to 2 or less, runs thrown away after restarts drop from about 0.7 to 0.2 or less per restart, and no change merged on a kept result breaks the main branch. If one does, we review at once.
