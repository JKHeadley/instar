# ELI16 — Pool-Consistent Activation for Multi-Machine Features

## The short version

The new "prove it live" standard just did its job and caught a real bug in my own
cross-machine transfer fix — a bug that all 49 of my automated tests missed, because they
only ran on one machine. This spec fixes that bug.

## What went wrong

Some features ship "dark" (off by default) and only turn on for my *development* machine,
so I can test them safely before they go everywhere. The switch that decides "is this a
dev machine?" is read **separately on each machine**. My agent ("echo") runs on two
machines — a laptop and a Mac Mini. On the laptop, the dev switch was on; on the Mini, it
was off (just an oversight in how the Mini was set up).

The transfer fix needs to be running on **both** machines to work: when a conversation
moves from the laptop to the Mini, the laptop records "the Mini owns this now" and sends
that record across — but the Mini has to be running the fix to *receive and apply* that
record. Because the fix was off on the Mini, the Mini ignored the record. So the
conversation "moved" on paper but the Mini never realized it owned it — the exact original
bug, still alive. The seat moves on one side and dies on the other.

## The fix

A feature that needs both machines can't depend on a switch that each machine reads on its
own — if they disagree, the feature is half-on and broken. So:

1. **Turn the transfer fix on wherever its real prerequisite is on.** The fix depends on a
   "sync the records between machines" system that *is* already turned on consistently on
   both machines. So instead of asking "is this a dev machine?", ask "is the record-sync
   running here?" — and if it is, run the fix. That makes it come up on both machines
   together.
2. **A tripwire so this can't happen silently again.** Add a watchdog that notices when a
   two-machine feature is on for one machine but off for the other, and flags it loudly
   instead of letting it quietly half-work.
3. **Write down the lesson** so the next two-machine feature I build doesn't repeat it.

## Why it matters to you

Without this, "the transfer is fixed" would have been a lie — it works in my tests and on
my main laptop, but the moment a conversation actually moves to the Mini, it breaks. The
standard caught that before I told you it was done. After this fix, I re-run the real
laptop↔Mini test, and only call it fixed when a reply genuinely comes back from the Mini.
