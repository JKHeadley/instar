# "We have enough evidence" — about nothing at all

## The one-paragraph version

Your agent keeps score on its own judgment calls. Every time one of its internal checks
makes a decision, that decision can later be graded: **right**, **wrong**, or **unknown**
— unknown meaning nobody ever established which it was.

Beside those counts it publishes a warning flag: *do we have enough evidence here for
these numbers to mean anything?* The flag was calculated by adding up all three
categories. But "unknown" is not evidence — it is the word for having none.

So a check with 2,004 decisions, **zero** graded right, **zero** graded wrong, and 2,004
graded unknown was reporting: **we have plenty of evidence.** About nothing.

## Why that is worse than a wrong number

A wrong number gets questioned. A confident "yes, this is reliable" gets *believed*.

Two of your busiest internal checks were in exactly this state. Anyone reading their
scoreboard would have seen "enough evidence" sitting next to "zero times wrong" and drawn
the obvious conclusion: **this check has never made a mistake, so maybe it doesn't need
the power to block things.**

That conclusion would have been completely wrong. The check hadn't been proven right — it
had never been graded at all. And this is not hypothetical: I was in the middle of writing
exactly that kind of review earlier tonight. What stopped it being published was me
noticing the underlying numbers were empty, not the flag whose entire job is to warn about
empty numbers. The flag was actively giving the green light.

## What changed

Three small things:

- The scoreboard now also shows **settled grades** — how many decisions were actually
  established as right or wrong. That's the number that can support a percentage.
- It shows **what share is unknown**. If that reads 100%, nothing is established.
- The "enough evidence" flag now counts settled grades instead of counting rows.

The old counts are still published, unchanged, because they answer a different and still
useful question: *how many decisions got looked at at all?*

## What you'll notice

The two busy checks will flip from "enough evidence" to "not enough evidence." Nothing has
got worse — that has been true the whole time and the display was wrong. This is a
scoreboard, not a gate: it blocks nothing, delays nothing, and changes no behaviour.

## The wider pattern, honestly

This is the **seventh** recorded instance of one shape: a measurement that reports the
ideal value when it actually has nothing to measure. An empty index scoring 100% fresh. A
directory listing returning zero for a folder with files in it. Same mistake, different
place, seven times.

That was written up as a critical item three days ago, with a rule already stated for it:
*every completeness measure must carry its denominator and say "nothing measured" rather
than report a perfect score.* I found this instance without remembering that item existed,
which is its own uncomfortable data point.

That rule is precise enough to be enforced automatically rather than found by hand each
time. Building that check is the real fix and it is bigger than this change; this one
repairs the instance that was best placed to mislead a real decision.
