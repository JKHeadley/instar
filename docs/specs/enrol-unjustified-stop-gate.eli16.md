# Starting to keep records on the busiest judgment call — plain English

## The one-sentence version

There's a system that decides whether I'm allowed to stop working, it makes that
call about two hundred times a day, and until now nothing recorded what it
decided or why.

## Background: the thing that keeps me working

When I try to end a session, something checks whether stopping is legitimate.
Finished the work, hit a real error, need a decision only you can make — those
are fine. "This is getting long, let's pick it up fresh" is not, and it gets
refused.

It's one of the busiest judgment calls in the system: roughly 1,300 times a
week, second only to the check on my outgoing messages.

## The problem

There's a separate system whose job is to answer "are these judgment calls
actually any good?" — worth knowing, since a check that's wrong half the time is
worse than no check.

It can only answer for decisions that were **recorded**. About sixty judgment
points exist; seven were recorded. The stop check was not one of them, despite
being the busiest. Nobody could say whether it was right, wrong, too strict, or
too lenient, because nothing was written down.

This starts writing it down.

## What gets recorded, and what deliberately doesn't

The stop check reads two things: evidence gathered by the system (which files
changed, which commits exist) and **untrusted content** — my stated reason for
stopping, plus the last ten turns of conversation.

That conversation is the sensitive part. It's whatever we happened to be
discussing, which could be anything.

So none of it is recorded. What gets stored is the *shape* of the decision:

- a fingerprint of my stated reason — enough to tell two different reasons
  apart, not enough to read either
- how long it was, how many turns there were, how long they were
- which pieces of evidence existed, and of what kind
- which warning signs fired (those are computed by code, not written by anyone)

Enough to reconstruct what the decision looked like. Not enough to reconstruct
the conversation. The tests check this by putting a fake password and a fake API
key into the input and asserting neither appears anywhere in what gets stored.

## The half I'm not pretending to have done

Recording a decision is not the same as knowing whether it was **right**.

To grade this one you'd need a fact that comes later: after the check allowed a
stop, did the work turn out to be unfinished? After it refused one, did I
actually go on to do something useful? Those facts exist elsewhere in the system,
but connecting them to a specific decision is real work, not a small addition.

So this records decisions without grading them, and **says so explicitly** in the
record itself, using a category that exists for exactly this situation. The
system's own health check reads that category and reports this point as
measured-but-not-graded rather than counting it as fully done.

That distinction matters more than it sounds. The easy version of this change
would move a number from "not covered" to "covered" and leave anyone reading it
believing the busiest judgment call in the system was being evaluated. It
wouldn't be. Saying which half is missing is the difference between a smaller
number and a truer one.

The reason it's still worth doing now: records only accumulate going forward. If
the grading arrives in a month and nothing was recorded, it starts from zero.
This way there's history waiting for it.

## What you'd notice

Nothing. This is instrumentation on an internal judgment — no new behaviour, no
messages, nothing user-facing. What it buys is that the question "is that check
any good?" stops being unanswerable in principle and becomes merely unanswered
for now.
