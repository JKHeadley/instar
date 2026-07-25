# The feature nobody could use — plain English

## The one-sentence version

I shipped the dated-reminder feature this morning with working code, tests, and
an endpoint — and forgot to tell any agent it exists, which means no agent would
ever have used it.

## How that happens

Agents don't read the codebase to find out what they can do. They read one
briefing document that lists their capabilities. If a capability isn't in that
document, it may as well not exist — the code runs, the endpoint answers, and
nothing ever calls it.

There's a written rule about this: every new feature must be added to that
briefing at the same time. It's a rule I've read many times.

Nothing enforces it. So I shipped the feature and skipped the briefing, and no
test, gate, or check said a word.

## What that would have cost

The reminder feature works by noticing that a promise carries a date. I set that
date when I make the promise. If I don't know the field exists, I never set it —
and a background job then scans an empty list, finds nothing, reports success,
and does that every five minutes forever.

Working code. Passing tests. Green health check. Zero reminders, permanently.
That is the same failure shape as everything else I found tonight, and this one
would have been mine start to finish.

## The part that's easy to get wrong

There are two audiences: agents created *after* this change, and agents that
already exist. New ones get the briefing fresh. Existing ones only get changes
through an update step.

The update step for this part of the briefing is guarded by a check that means
"only if the whole commitments section is missing." Every existing agent already
has that section — so anything I added inside that guard would reach new installs
only, and every agent that's currently running would stay unaware.

So the new material gets its own separate update rule, one that fires when the
section is present but this specific piece isn't. There's a test asserting
exactly that separation, because it's the kind of thing that looks correct in a
diff and quietly reaches nobody.

## One deliberate choice

If an agent has customised its briefing so the wording no longer matches, the
update appends the new material rather than skipping. A slightly misplaced
paragraph is a small cost; an agent permanently unaware of a capability because
it edited its own notes is a large one.

## What the briefing now says

Not just "here's an endpoint" — that's discoverable only by someone already
looking. It says when to use it (you promised something by a date), which field
to set, that the date must be a real moment rather than the word "Friday", which
field to check to find promises that were never delivered, and — plainly — that
the feature ships switched off and does not yet guarantee what it eventually
will.

That last part matters. A briefing that oversells a capability produces an agent
confidently relying on something that isn't running.

## What you'd notice

Nothing directly. But it's the difference between the feature existing and the
feature being usable, and I'd rather fix that the same day I caused it.
