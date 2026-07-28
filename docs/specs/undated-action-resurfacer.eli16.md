# Re-surfacing the 98% — in plain English

## The problem, in one paragraph

Your agent keeps a to-do list of things it has noticed and should fix. It has a mechanism for bringing
old items back to your attention so they don't rot — a job that runs every four hours and says "these
are overdue."

That job only looks at items that were given a **due date**. Almost nothing gets one, because nothing
requires it. So of 912 open items, it can see **eighteen**. The other 894 are not being ignored —
they are **invisible to it**, permanently, and 581 of those are marked high or critical. The oldest
one nobody can reach is 24 days old.

## Why that matters more than it sounds

Two real cases found this week:

- One item was written down, verified as real, and then **rediscovered five separate times over
  fifteen days** by different pieces of work — each time from scratch, each time costing an
  investigation. It had no due date, so it was never once brought back.
- Another was marked *critical* and left alone for two days while the problem it described **got
  worse** — the failure rate it measured climbed from 81% to 86.5% while it sat there.

Neither was a case of bad prioritisation. Nobody looked at these and decided they could wait. They
simply could not be seen by the only thing whose job is to bring things back.

## What this adds

One rule: **every run, bring back exactly one forgotten item — the oldest important one nobody has
looked at.** Then leave it alone for two weeks. If it comes back three times and still hasn't moved,
say so once and stop.

That's the whole thing.

## Why "exactly one" and not "all of them"

Because there are 581 of these right now. A component that announced all of them — or even a daily
digest of them — would bury the very surface it's supposed to help. Your agent already has a ceiling
built specifically to stop that kind of flood, and it exists because that mistake has been made
before.

One at a time won't clear the backlog, and it isn't meant to. It means **no item can sit forever
untouched**. Six a day, oldest first, and the worst case is bounded by arithmetic rather than by
someone choosing a threshold correctly.

## What it deliberately cannot do

It never marks anything done, never cancels anything, never changes a priority, and never decides an
item doesn't matter. It brings one thing back into view and says nothing else. Every judgment stays
with you.

## How you'd know it's working

Not by a passing test — by watching it name a specific old item that genuinely could not have been
raised before. It ships switched off, then in a mode where it only *logs* what it would have raised,
so the choice can be checked against a real 581-item backlog before it says anything out loud.

## The honest limits

**It does not clear the pile.** 581 items, one per run, is not a drain — it's a guarantee that nothing
sits forever. Clearing what has already accumulated is separate work and this doesn't pretend
otherwise.

**It only covers high and critical items to start.** Medium and low undated items are a bigger group,
and adding them later is straightforward — but the measured damage is in the important ones, so that
is where it starts.

**One design question is genuinely open**, and it's written down as open rather than guessed: if you
run your agent on more than one machine, both could bring back the same item unless they share a
record of what's already been raised. There are two reasonable answers and the smaller one is probably
right — but "probably right" is exactly how features get shipped machine-blind, so it gets decided
before it gets built, not after.
