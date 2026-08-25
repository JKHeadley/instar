# Plain-English overview — Null-Effect Verdict for Feature Metrics

## What this is, in one breath

I keep a scoreboard of every background check I run: how many times it ran, how
often it errored, and how often it actually *did* something. I look at the error
column. I have never looked at the "actually did something" column. This change
makes the scoreboard say, out loud, when a check has run thousands of times and
done nothing at all.

## The problem, told as what actually happened

I have a habit I have written down about myself: when something produces no
output, I read that as healthy. Silence looks like calm.

Here is what that habit costs. One of my checks, called `durable-output-scrub`,
ran 8,806 times over the last week. It made a decision every single time. Every
single decision was "nothing to do here." Zero errors. On every screen I look
at, it scored perfectly — because the only thing being graded is how often
something *breaks*. A check that runs cleanly and accomplishes nothing gets full
marks.

That is not a one-off. It is the same shape as three other lessons I have
written this month: a scheduled sync that silently skipped itself for five days
while its settings still said "on"; three jobs that never ran at all one
morning, one of which was the monitor whose whole job is to notice jobs not
running; a filter that has never once had anything to filter, because the thing
that was supposed to fill it in never did.

Every one of those already had the right number sitting in a column somewhere.
Nothing read the column.

## What I found when I checked, which changed the plan

The original proposal said: flag anything that ran a lot and never acted.
Simple rule. I ran it against real numbers before writing the code, and it would
have been wrong 13 times out of 14.

It turns out there are two very different reasons a check shows zero actions.

The first is the real problem: the check makes a decision every time, and the
decision is always "do nothing." That is `durable-output-scrub`. Genuinely dead
work.

The second is *not* a problem with the check at all — it is a problem with the
scoreboard. Thirteen of my checks never report their decision back to the
scoreboard in the first place. They act; the scoreboard just never hears about
it. The clearest example is the gate that reviews my outgoing messages. It is
always on, it blocks real things, and on the scoreboard it looks exactly as idle
as the dead one.

So if I had shipped the simple rule, I would have hung a red flag on a working
safety gate and called it dead. That is the same mistake as the original problem,
just pointed the other way.

The fix keeps them separate. One verdict means "this decides, and never acts" —
that one is worth someone's attention. A different, quieter verdict means "this
never tells me what it decided" — that is a wiring gap to fix later, and it does
not get to light up a warning on thirteen things at once, because a warning
that is always lit is a warning nobody reads.

## What actually changes

Three small things, all in the place I already look:

1. Each check on the scoreboard gets a plain verdict next to it: *acts*,
   *does nothing*, *never says*, or *too few runs to tell*.
2. The summary at the top lists which checks are doing nothing — by name, not
   just a count. A count that says "2 problems" without saying which two is the
   same defect all over again.
3. The health summary gains one line when a check is doing nothing. It says
   "degraded," not "broken" — wasted work is waste, not an outage, and it should
   not wake anybody up.

## What this deliberately does not do

It does not turn anything off. It does not pause, throttle, or retire a check
that scores badly. It only says what is true so a person can decide. A number
that grades something is not permission to act on it.

It also does not fix the thirteen checks that never report their decisions. That
is a real gap and a bigger one, but it is a different repair in a different
place, and bundling them would mean neither gets done properly.

## How I will know it worked

There is exactly one right answer on the first run: `durable-output-scrub`, and
nothing else. If the new verdict comes back naming fourteen checks, it used the
simple rule, and the whole point of checking the numbers first was missed.
