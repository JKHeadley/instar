# The size limit that was never a size limit — plain-English overview

## What this actually is

I keep four running lists of my own self-improvement work: things I've proposed, lessons I've
learned, gaps I've noticed, and actions I've committed to. Each list has a configured maximum
size, and code that trims the list whenever it's saved.

On 2026-08-30 I measured them. The actions list holds **352 records against a maximum of 300**,
in a 300 KB file that gets read and rewritten in full every single time I record anything. The
limit has been sitting there, doing nothing, for a long time.

There are two reasons, and the second one is the important one.

## Reason one: the trimmer does the opposite of what it says, at exactly the wrong moment

The trimming line computes "how much room is left" and then keeps that many old records. When
the list is under the limit, it works. When the list goes **over** the limit, "how much room is
left" comes out as zero — and the way this particular piece of code asks for "zero records", the
language hands it back **every record instead**.

It's a real quirk, not a typo: asking a list for "the last zero items" and asking it for "the
last nothing-in-particular items" look identical here, and the second meaning wins. So the code
reads *"keep nothing"* and behaves as *"keep everything"* — and only ever at the moment the limit
is actually needed. Below the limit it's correct, which is why nobody caught it. The broken case
was the untested case.

The same line appears in **four** places — one per list. The original report found two. Three of
the four lists just haven't grown big enough yet to show it.

## Reason two: the limit was never allowed to touch the part that grows

This is the one that matters.

The trimmer is only permitted to remove **finished** records — completed or cancelled actions,
applied lessons, closed gaps. Anything still open is protected, on purpose: you don't want your
own to-do list silently deleting your to-dos.

But open items are the only thing that accumulates. Right now 350 of the 352 actions are open.
So even if the trimmer worked perfectly, it would remove the 2 finished records and leave 350 —
still over the limit, and permanently, because nothing in the system ever removes an open item.

**"Maximum 300 actions" is really "maximum 300 finished actions," and it's wearing the name of a
limit on the whole list.**

That's why fixing the first problem on its own would make things *worse*, not better: the code
would start looking correct while the file kept growing, and the next person to read it would
have no reason to look again.

## Why it hid so well

If the trimmer had been over-aggressive — deleting too much — the file would look like: a few
hundred open items and almost no finished ones. That is *exactly* what the file looks like now,
for the opposite reason. Two contradictory faults produce the same picture, and nothing in the
report says which one you're looking at, because the report only prints one number: the total.

## What the fix has to do

Three things, and they have to go together:

1. **Fix the trimming line** in all four places, so that "keep zero" means zero. With tests for
   the over-the-limit case specifically — the case that's wrong today.
2. **Decide what actually bounds the growing part**, and say so honestly. Either rename the
   setting to what it really limits (finished records) and raise a flag when the list outgrows it
   anyway, *or* give open items a genuine bound — an expiry, or moving old ones to a cold file.
3. **Report three numbers instead of one**: how many records total, how many are protected, how
   many are actually removable. One number can't tell "we trimmed too much" apart from "there was
   nothing we were allowed to trim."

## What you actually need to decide

**Only step 2.** Steps 1 and 3 are unambiguous repairs. Step 2 is a policy choice with a real
consequence for you: option (a) is honest but the file keeps growing; option (b) stops the growth
but means that at some point one of my own open commitments gets aged out or archived, and that's
a decision about my memory that isn't mine to make quietly.

The spec deliberately does **not** pick one. That's the question for you.

## What is not being proposed

No incremental-write or database change for the 300 KB rewrite cost. That cost is a symptom of
the list growing without bound — fix the bound and the cost fixes itself. Adding machinery for it
now would be treating the symptom.
