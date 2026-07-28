# Plain-English overview — the outbound gate becomes a nudge

## What sits between the agent and you today

Every message the agent sends you passes one final check. A model reads the
draft and decides: does this go out, or not? It has about twenty reasons it can
refuse — this looks like a leaked file path, this reads like the agent quitting
on itself, this looks like a duplicate, this is jargon a person can't act on.

Right now that check has the last word. When it says no, the message dies. The
agent has no recourse and you never learn the message existed.

## Two problems with that

**The first is obvious.** The check is a model making a judgment call, and
judgment calls are wrong sometimes. When it wrongly refuses, you get silence —
and silence is indistinguishable from the agent having nothing to say. You have
personally hit this: asking for a path or a technical detail and getting a
reply that carefully talks around the thing you asked for.

**The second is the one that actually forces the change.** The system records
every one of these decisions so they can be graded later — was the check right
or wrong? Over the last week it recorded more than twelve hundred decisions and
graded exactly zero of them right or wrong. All unknown.

The reason is structural. A hard refusal leaves nothing to observe. The check
says no, the message dies, and there is no trace of anyone disagreeing. There
is no argument on the record for a judge to rule on later. The data the whole
grading effort depends on cannot exist while the check is a wall.

## What changes

The check keeps running, and keeps giving its opinion. But its opinion becomes
a nudge rather than a verdict. When it objects, the message comes back to the
agent with the objection named. The agent then either rewrites it — often the
right move, the check is frequently correct — or sends it anyway and states,
in writing, why the check was wrong.

That written reason is the point. It is not optional and it is not a checkbox:
a resend without a real reason does not go through. Every override becomes a
recorded disagreement — here is the message, here is what the check said, here
is why the author disagreed. That is exactly the material a strong model can
grade later, in bulk, without hurrying: who was right, the check or the author?

## The one thing that stays a wall

If a message is about to carry a real live password or key, that is refused
outright, with no override available. The agent does not get to argue its way
past it.

That refusal is deliberately not a model's judgment — it is a mechanical check.
It does not guess based on how random a string looks, because guessing produces
false alarms, and a false alarm on a wall you cannot override means a message
you never receive.

**The wall is drawn where the check is certain, and only there.** An earlier
draft of this design gave the whole mechanical check that unappealable
authority, and three independent reviewers caught the same problem: part of the
check is a guess wearing the same uniform. It flags anything following the words
"password" or "token", so an ordinary sentence to you — *"your api key is not
configured yet"* — would have matched and been refused permanently, with the
agent unable to argue and you never learning the message existed. That is the
exact failure this whole change exists to remove, rebuilt inside the one place
it was supposedly safe.

The first draft drew the line at "unmistakable key formats". Review pushed it
further, and the final line is narrower and simpler: **the wall is possession,
and nothing else.**

- **Certain** — the text contains a key this machine actually holds, checked by
  direct comparison. Refused outright, no override, ever.
- **A guess** — anything that merely *looks* like a credential. The message still
  stops, but the agent can send it with a recorded reason, like every other
  check.

The reason for the second narrowing: no pattern is proof. A sentence explaining
what a token looks like contains something shaped exactly like a token. Under
the earlier draft that sentence could never reach you, and nobody could appeal
it. Your own words for the one wall were "an actual live password or key" —
actual, not shaped.

What that costs is worth naming: a real key that belongs to some *other* account
is now a stop-and-explain rather than an absolute refusal. The wall was only
ever protection against an accident — a determined agent could always split or
describe a secret to get around it — and stopping the message dead until someone
consciously writes down a justification is complete protection against accidents.
What's bought is that no ordinary sentence gets silenced forever by a pattern.

Everything else is recoverable. A leaked path is embarrassing; a leaked live
key is a real-world incident. So one wall, drawn narrowly and honestly, and
everything else becomes a conversation.

## Making the record worth reading

Producing disagreements is only half of it. They have to land in a record a
strong model can actually judge months later — and a gap in that record cannot
be filled in afterwards, because you cannot reconstruct a conversation nobody
wrote down.

Checking what is stored today surfaced one gap that undoes most of the value.
Before deciding, the check is shown the recent conversation. What gets stored is
how *many* recent messages there were — not what they said. But "was holding
this message right?" is almost never answerable from the message alone. It is
answerable from what you had just asked. Judged on the message alone, a check
that blocked a technical detail you explicitly requested looks correct. A judge
reading these records would therefore side with the check on precisely the cases
worth catching, and the resulting numbers would look healthy while being wrong.

So this change also fixes what gets written down: the conversation the check was
actually shown, the agent's state at the time, and an honest marker when the
model's own reasoning was cut short for length. Each stored decision is labelled
complete or incomplete, so an incomplete record can never quietly pass as a
complete one. It ships in the same change as everything else, because the rest
of this work makes decisions accumulate *faster* — shipping it alone would just
build a bigger pile of records nobody can grade.

## What it means for you

Fewer messages that quietly never arrive. And, for the first time, a record of
where the automated checks and the agent actually disagree — which is the raw
material for making the checks better, choosing the right model for the job,
and turning the interesting arguments into a permanent test suite so the same
mistake is never re-made.

## What it does not do

It does not decide who was right. Nothing in this change grades anything. It
produces the evidence; the judging happens afterwards, in bulk, on a strong
model, exactly as you asked. An override is recorded as *a disagreement*, never
as proof the check was wrong — the agent is just as capable of being wrong as
the check is, which is precisely why both are being measured.

Richer recording gets its **own** switch, separate from the one that already
exists for storing the agent's own drafts, and it is off until it is turned on.
That separation is deliberate: the existing switch means "keep what I wrote", and
quietly upgrading it to also keep *your* side of the conversation would widen
what was agreed to without anyone deciding. And the widened behaviour cannot go
live without it — an override nobody can grade later is the thing this change
exists to stop producing.

The widened behaviour ships switched off, and gets turned on deliberately. The
credential wall ships on from day one — a new protection against an
irreversible mistake is not something to soak-test.


## What twenty-eight rounds of review actually changed

This design was reviewed twenty-eight times — by an automatic check against the
project's own written standards, and by two AI reviewers from other companies
reading it cold. Roughly a third of what was originally designed survived. The
changes worth knowing about:

**The wall got much narrower, three times.** It started as "refuse anything
shaped like a key". Each narrowing came from the same objection: a shape is not
proof. An ordinary sentence — *"your api key isn't configured yet"*, or one
explaining what a GitHub token looks like — matches those shapes. Under the
early design, those messages would have been refused permanently with no appeal
and you would have seen silence. The wall is now exactly one thing: the message
contains a key this machine actually holds, checked by direct comparison.
Everything else that merely looks like a credential stops the message and asks
the agent to justify sending it.

**A safety brake that could only tighten.** The design had: if the agent
overrides a check too often without evidence it was right, that check reverts to
being absolute. Sensible — except the evidence system that would release the
brake doesn't exist yet. It could only ever tighten, and over weeks would have
quietly walled everything back up while appearing to work. It now raises a flag
for the operator instead, and only becomes automatic once real evidence exists.

**Six times, in six different places, the design created a stop that nobody
could argue with** — the exact thing it exists to remove. Each was fixed
individually as a reviewer found it, which guaranteed a seventh. The rule is now
written down once: *a hold only exists where there is a way to answer it.*

**A lot of machinery was deleted.** An elaborate scheme for finding credentials
without holding them in memory turned out to protect a door that was already
open — the process holds several of your credentials in plain text anyway. A
queue for holding messages while the reviewer was offline turned out to be a
small workflow engine reinvented; the agent can simply try again later, and now
records a durable reminder to do so.

## What you'll actually notice

Fewer messages that quietly never arrive. A record, for the first time, of where
the automated checks and the agent disagree — which is the raw material for
making the checks better, for choosing the right model for each kind of
judgment, and for turning real arguments into permanent test cases.

And one honest caveat: nothing here grades anything yet. This produces the
evidence. The judging happens afterwards, in bulk, on a strong model — which is
the piece that comes next.
