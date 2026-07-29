# Why the fix for forgotten tasks is the wrong fix for forgotten promises

## Two different things that look the same

Your agent keeps two lists.

One is **tasks it set itself** — things it noticed and thought it should fix. 912 of those are
open.

The other is **promises it made to you** — sentences like "I'll ship that fix" or "I'll check
the failover and report back." 307 of those are open, and 57% of them are more than a week old.
The oldest is 52 days.

Earlier this session I designed a way to stop the first list rotting: every so often, bring back
one forgotten task so it can't sit invisible forever. That design is written up and merged.

The obvious next step is to point the same machinery at the promises. **That turns out to be
exactly wrong, and the reason is worth reading.**

## Three reminders, none of them reaching anything

There are already three mechanisms meant to stop things being forgotten. All three run on
schedule. All three report themselves as working.

- The task reminder can only see tasks that were given a due date. **18 of 912 were.**
- The promise reminder can only see promises that were flagged for it. **10 of 307 were.**
- A third one handles promises with a specific date attached. **Zero of 307 have one.** It has
  been switched on, running, and reporting success without ever having had a single thing to
  look at.

None of them is broken. They do precisely what they were built to do. The problem is that
signing something up is optional, so almost nothing is signed up — and a reminder with nothing
to remind looks identical to one that's working.

## Why promises need the opposite treatment

Here's the part that decides it.

Your agent has a rule about promises: **if the promise is the agent's own work, you should never
be chased about it.** You hear about it when there's a result, not a status update. That rule
exists because being pinged about someone else's to-do list is not help.

Of the 307 open promises, **287 are exactly that** — the agent's own work, with nothing blocking
it. Only three are genuinely waiting on you.

So bringing forgotten promises back **to you** would break the rule this whole effort is meant
to serve. It would turn a follow-through mechanism into a nagging stream, at a volume of 287,
which is precisely the flood there's already a ceiling to prevent.

The forgotten promises need to come back **to the agent** — into its own head at the start of a
session, the way it already gets reminded who you are and what you prefer. Then it either
finishes one or honestly says it can't, and you see a result. Which is what you were promised.

## What I'm deliberately not deciding

Three things, all real questions:

- **How many to bring back per session, and which ones.** Oldest-first sounds right and probably
  isn't — fifteen very old promises would hog the slot for a fortnight while a hundred-odd
  slightly newer ones quietly aged past them.
- **What it costs.** Space at the start of every session is expensive and permanent. That has to
  be argued, not assumed.
- **Whether 287 is a pile to clear or a sign of something upstream.** More than half are over a
  week old, which hints that promises are being made faster than any clearing could keep up. If
  so, the fix belongs at the moment a promise is made, not in a machine that chases them
  afterwards.

## The honest summary

The upstream flow fix has now been built: a new promise or task must either join its follow-through
mechanism with a real date, or explicitly record why it has no schedule. Leaving both blank is
refused, and choosing both is refused. That stops new invisible rows being created by omission.

What was deliberately **not** built is a machine that dumps the old promise pile into your
notifications. The existing stock still needs a separate judgment, and the rule remains that the
agent's own work comes back to the agent, not to you as status noise.

Three reminders, reaching 2%, 3% and 0%. All working. All nearly empty. The common thread is
that signing up was a box nobody had to tick. New creation now forces that decision where the
promise or task is made; it does not pretend the existing pile vanished.
