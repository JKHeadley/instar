# Queue pace — plain-English overview

**The problem.** Instar has several "to-do piles" that background jobs work through: feedback
reports, feedback fixes, maturation fixes, promises (commitments) and self-improvement action items.
Justin asked a simple question: is each pile shrinking, or growing? And when a pile grows faster
than it is worked, does anything speed up? Today the answer to both is no. We can see how big a pile
is right now, and in one place how many things got finished, but nothing compares "how many came in"
with "how many got done", and every job runs at a fixed pace no matter how far behind it is.

The evening this was asked, the numbers showed why it matters, and why "just run faster" is not
enough on its own. About 350 feedback reports a day were arriving; 386 items were marked as needing
a fix, and only 4 had one. The builder that writes fixes was not running at all, because it allows
at most 4 open fix pull requests and all 4 were waiting for Justin to approve them. Running the
builder more often would have done nothing; the limit was a person, not the job.

**What changes.** Three pieces, each reading things Instar already records:

1. **A pace measure for every pile.** Every hour, for each pile, Instar notes how many items came in,
   how many were finished, and how many are still open. From a week of that it says plainly whether
   the pile is catching up, holding steady, or falling behind, and how many days it would take to
   clear at the current pace. If it cannot read a pile reliably it says "unknown", never a made-up
   zero.

2. **The reason a pile is behind.** For a pile that is falling behind it names the limit: the worker
   itself is too slow; a fixed cap stopped it; the account's usage limit paused it; or the work is
   waiting on a person (for example, fixes waiting for approval). Each reason must be backed by what
   the system actually recorded; otherwise it says "unknown".

3. **A careful speed-up, only where it helps.** When — and only when — the worker itself is the slow
   part, Instar runs that job extra times between its normal runs, with a minimum gap and a daily
   limit, and stops as soon as the pile is no longer falling behind. Every safety check that applies
   to a normal run still applies to these extra runs. It never raises any limit Justin set, never
   spends past an approved budget, and never pushes harder when the real limit is a cap, the usage
   limit or a person.

**When Justin hears about it.** Only when speeding up cannot help: the pile has been held back by a
cap, the usage limit or a person for six hours, or the extra runs are at their daily limit and the
pile is still losing for a day. Then he gets one plain message per pile, naming the blocker and the
one thing that would unblock it (for example, links to the fixes waiting for approval). It closes on
its own once the pile stops falling behind.

**Where to see it.** A "Pace" card in the new console's Work section, one line per pile, coloured by
how it is doing; a pace line on the feature maturation board; and a read endpoint for agents.

**Safety and rollback.** It starts in watch mode: it measures and shows everything, but the speed-up
only records what it would have done, and messages to Justin are recorded rather than sent, until
they are switched on. One setting turns the whole thing off. Nothing else reads what it writes, so
turning it off or deleting its logs is harmless.

**What the reader needs to decide.** Nothing before it is built. Later, after watching what the
speed-up would have done, whether to switch it on.
