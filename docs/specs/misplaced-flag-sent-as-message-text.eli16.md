# A setting in the wrong place was sent to you as a message — Plain-English Overview

> The one-line version: an option meant to configure how a message was sent got
> pasted into the message instead, and nothing said so — which quietly put a wrong
> entry in the records that measure whether my safety checks are any good.

## The problem in one breath

When I send you a message, I run a small script. The script takes the message, the
destination, and optionally some settings — written as `--like-this`.

The script reads settings only until it meets the destination. Everything after
that it treats as the words of the message. So if I put a setting *after* the
destination, it stopped being a setting and became text — and you received the
raw option as part of what I said.

Two things went wrong at once, both silently:

1. **You saw the plumbing.** The option appeared in your chat as literal text.
2. **The setting never took effect.** Whatever it was supposed to do, didn't.

## Why the second one matters more

One of those settings is how I record disagreement with a safety check.

When a check flags a message, I can either accept the correction, or say "no, this
check is wrong here, and here's why" and send anyway. Both answers are recorded,
and those records are what make the check better over time. Agreement teaches it
it was right; disagreement teaches it it was wrong.

On the 26th I disagreed with a check — and put the option in the wrong place. So my
disagreement never arrived. The check re-examined the message, which now had
option-text stuck to the front of it, and returned a verdict that looked absurd to
me. I concluded the check had malfunctioned and recorded it as **wrong**.

It hadn't malfunctioned. It had judged, correctly, the strange thing I actually
handed it. I put a false mark against a check that was working, in the very data
used to decide which checks to trust. That record is durable.

## The actual root cause, which is not the script

Here is the part worth sitting with. **Those options were documented nowhere.**

The instructions I follow say two things: always send through this script, never
hand-roll the request yourself; and, to record agreement or disagreement, set these
named fields. But those named fields belong to the direct interface — *not* to the
script I am required to use. Nothing anywhere said how to express the one through
the other.

So I did what anyone does with an undocumented tool: I guessed a plausible form.
I guessed wrong, and the script accepted my guess without complaint.

It is not really a typo. It is a capability that shipped without instructions, and
a tool that stayed silent when used the only way an uninstructed person would use it.

## What changed

**Three things, because it took three to close it.**

1. **The script now refuses.** An option after the destination stops the send and
   explains the ordering, showing the corrected command. Nothing is sent — better
   the message is delayed than sent wrong with its setting dropped.

2. **It also catches misspellings.** `--tone-akc` used to sail through as message
   text. It is now refused too. This is the realistic mistake, and it was just as
   silent.

3. **The options are finally documented** — in the script's own help, and in the
   standing instructions, with a worked example showing the correct order. The
   guard makes the mistake loud; the documentation makes it rare.

There was an inconsistency underneath all this that made the fix obvious once seen:
the script *already* rejected an unrecognised option when it appeared *before* the
destination. It was strict about nonsense in one position and completely permissive
about a real option in the other. Now it treats both the same way.

## Making sure this actually reaches anyone

Instructions like these are delivered by an updater that checks "does this agent
already have this section?" before adding it. The section already existed — I was
only adding a few lines inside it. So every already-running agent would have
skipped it, and only brand-new ones would have got the fix.

That trap is the reason for a test whose whole job is to simulate an agent that
already has the old text and prove it still receives the new part. I verified that
test genuinely fails when the delivery mechanism is removed, so it cannot quietly
become decorative.

## What this does not fix

The false record from the 26th is still there. This stops the cause; it does not
retract the effect. Whether a mistaken grade *can* be corrected — and whether
correcting one erases the evidence that it was ever made — is a separate open
question, deliberately not answered here.

And more generally: this closes one undocumented option on one script. It does not
establish that every other capability is documented. The lesson generalises further
than the fix does — **a tool that silently accepts a wrong usage is worse than one
that has no feature at all**, because the silence gets recorded as a result.
