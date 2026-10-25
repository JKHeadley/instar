# ELI16 — The promise could be read but never written

## The one-sentence version

The field that makes "I'll check in on this by Friday" produce a real reminder was
read in four places and accepted from nobody, so every dated promise I have ever
made quietly lost its date on the way into storage.

## What this is for

When I tell you I will come back to something at a particular moment, that is
supposed to be recorded as a commitment carrying that moment. A recurring job then
looks for commitments whose moment has arrived and posts exactly one reminder into
the conversation where the promise was made. The point is that the promise survives
my session ending, a restart, or my context being compacted — none of which I can
prevent.

## What was actually wrong

The date has its own field, `checkInAt`, and the reasoning for that is written out
at length in the code: it is deliberately separate from the rolling "nudge me
again in a while" interval, because a specific promised moment and a repeating
heartbeat are different things, and overloading one field would let unrelated
cadence logic silently reschedule a promise.

All of that care went into the field's definition and its readers. Four places read
it. The function that creates a commitment never listed it among the things it
accepts — so a caller who passed a date got a success response and a record with no
date in it. Nothing errored. Nothing warned.

The honest consequence is visible in the system's own report: asked how many
commitments carry a date, it answered zero, across 883 of them. That answer was
correct. No commitment could have a date, because there was no way to give one.

## How I found it

By being caught by it. I promised the operator a message at eight in the morning,
tried to make that promise survive my session dying, and discovered the mechanism
designed for exactly that could not hold the date. What carried the promise in the
end was my session happening to stay alive.

## What changed

The create path accepts `checkInAt` and stores it. Two decisions came with it.

**A bare date is refused, not guessed.** "2026-10-24" is a perfectly valid
timestamp to a parser, and it means midnight UTC — so a promise for Friday would
have arrived at five o'clock Thursday afternoon for someone on the US west coast.
Rather than resolve it to an hour nobody chose, the request is refused and told
what to send instead.

**A date on its own still does not count as following through.** Creating a
commitment requires a real follow-through choice, and a dated check-in is not
accepted as one yet — because the job that posts the dated reminder still ships in
watch-only mode and would send nothing. Accepting a date as sufficient would record
the promise as covered by a mechanism that is switched off. That is the same trap
that let five finished fixes reach people unannounced this morning, and it is not
worth repeating for the sake of a tidier rule.

## What this does not fix

Half the feature. The date can be stored now; the reminder still will not fire
until someone deliberately turns the reconciler on, and whether to do that is a
decision with its own evidence to gather, not a thing to slip into this change.
Saying "a dated promise now produces a reminder" would be false. Saying "a dated
promise can now hold its date" is the whole of what is true.
