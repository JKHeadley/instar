# ELI16 — Live-Tail Event-Loop Guards

## What was going wrong

When you run me on two machines, the one that's "awake" continuously sends the
other one a copy of our recent conversations, so a takeover feels seamless. That
copying code had a brutal inefficiency: every 5 seconds, for EVERY conversation
it knew about, it re-read my ENTIRE message history file — up to 75,000 lines —
just to check if anything new had happened. Dozens of conversations × a huge
file × every 5 seconds, all on the server's single main thread.

That froze my server for 5–40 seconds at a time. And the freeze caused a second
problem: while frozen, the messages I send the other machine carry timestamps
that look old by the time they arrive, so the other machine rejects them as
suspicious. The copying code then retried the rejected send every 5 seconds,
forever — adding even MORE work to the already-frozen server. A loop feeding
itself. That's a big part of why the Laptop "ground to a halt" and messages got
stuck.

## The fix, in plain terms

Four changes, all about doing less pointless work:

1. **A cheap "anything new?" counter.** Each conversation now has a counter that
   ticks up when a message is logged. The copier checks the counter first — if
   it hasn't moved, it skips the conversation entirely. An idle conversation now
   costs basically nothing instead of a full file read.
2. **Remember recent messages in memory.** Instead of re-reading the giant file,
   each conversation's recent messages are kept in memory (seeded once from the
   file at startup, in a single pass, then kept current as messages arrive).
3. **Back off when rejected.** If the other machine rejects an update, wait
   5 seconds, then 10, then 20… up to 5 minutes between retries — instead of
   hammering it every 5 seconds forever. One exception: a deliberate machine
   handoff always gets to try immediately.
4. **Cap the size of one update.** A single update can't exceed 256KB — the
   receiving side never keeps more than that per conversation anyway, so sending
   more was pure waste.

## What changes for you

Nothing visible — except stability. The server stops freezing, messages stop
getting stuck, and the two machines stop convincing each other that the other
one is dead (which is what triggered the unnecessary machine-swapping). What the
standby machine ends up knowing is exactly the same as before; it just costs
almost nothing to keep it that way.
