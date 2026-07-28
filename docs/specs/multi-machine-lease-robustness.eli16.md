# ELI16 — Two bugs that stop "one agent on two machines" from working

When you run the same agent on two computers, exactly one is supposed to be
"awake" (in charge) and the other on standby. Two bugs, found live, stop that
from working reliably on agents whose state lives in a plain folder (not a git
repo). This spec fixes both.

## Bug B — the agent can't even shut down cleanly

Every agent keeps a bunch of little on-disk databases (for messages, tokens,
relay queues, and so on). When the program exits, those databases need to be
**closed first**. The code already knows this — it closes *two* of them before
exiting. But there are actually **fourteen**. If any of the other twelve is still
open when the program quits, the operating system trips over a leftover lock and
the program **aborts** instead of exiting — and then it just restarts and does it
again. We watched an agent get stuck in exactly this loop.

The fix: a single **"close-everything" registry.** Every database, the moment it
opens, signs into one list. On exit, one call closes them all. New databases
added later sign in automatically — so the close-list can never fall behind again
(this is the "make it structural, don't rely on remembering" principle).

## Bug A — two machines fight forever over who's in charge

Each machine writes down "I'm in charge" in its own local note, stamped with a
number that ticks up over time. Normally they compare notes and the one with the
older claim steps down. But when both machines were started separately and each
already believes it's in charge, they **leapfrog**: machine 1 says "I'm at
step 634," machine 2 says "no, I'm at 635," then machine 1 bumps to 636, and so
on forever. Neither ever yields, so you get **two captains** and nothing settles.

The fix has **two halves that must happen together** — getting just one wrong is
the trap that bit two earlier drafts of this spec. When a machine sees the *other*
machine also holding a valid claim at the same number, a fixed rule picks a
winner: the machine with the **lower ID stays in charge**, the other is the loser.

1. The **loser gives up its claim entirely** — not just "stops counting" (a
   machine that merely stops counting still *believes* it's in charge until its
   claim times out, and the winner can't force it out). It tears up its own note
   and goes to standby. This matters for a second reason too: while the loser is
   still flashing a live claim at the same number, the rulebook won't let the
   winner raise its number — so the loser letting go is what *unblocks* the winner.

2. The **winner then raises its number once** (from N to N+1). This is the part
   the earlier drafts missed: the code only ever *adopts* another machine's claim
   if that claim's number is **strictly higher** than its own. If the winner
   stayed at the same number, the loser would have nothing higher to adopt and
   would end up "headless" — recognizing no captain at all. By ticking up to N+1,
   the winner makes a claim the loser can plainly see is bigger, so the loser
   adopts it and stands down. It's a *one-time* bump to settle the tie, not the
   old per-beat counting — so there's no new leapfrog.

Result: one captain at N+1, the number stops climbing, and both machines agree on
who's in charge.

## Why this is a careful, spec-first change

Both fixes touch delicate machinery — process shutdown and "who's the boss"
election. A mistake in the first could lose unsaved data on exit; a mistake in
the second could make the *wrong* machine go silent. And neither can be fully
proven without two real machines running at once. So this is designed and
reviewed first, then each half is built with its own tests, and only then proven
live on a throwaway two-machine setup. Fixing the shutdown crash (B) comes first,
because while an agent is crash-looping you can't even observe the election (A).
