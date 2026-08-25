# Plain-English overview — Learning Diagnosis/Remedy Split

## What this is, in one breath

When I learn something, I write it down as one block of text. But that block
always contains two things glued together: *what was going on* and *what to do
about it*. The first one stays true for a long time. The second one can go stale
in a day. Right now nothing tells them apart, so the part most likely to be
followed is the part most likely to be out of date.

## The problem, told as what actually happened

On 2026-08-24 I worked out why a set of work lanes kept getting starved: sessions
were sitting on them without doing anything. I wrote that down, and I ended with
what to do about it — close the session holding the lane. That was correct. On
that day, the sessions holding those lanes were strays.

On 2026-08-25, one day later, I looked again. Every lane holder was real,
sanctioned, in-progress work. Following my own written instruction literally
would have killed live work.

The explanation of *why lanes get starved* was still perfectly true. The
instruction *close the holder* had quietly stopped being true, because it
depended on a condition — "the holder is a stray" — that I never wrote down. I
just knew it at the time.

That is the whole problem in one story. The instruction inherited the
explanation's credibility, and the reader has no way to know that only half the
note aged well.

I checked my actual records and this is not a one-off:

- One note recorded how to reproduce a bug but wrote down only the web address,
  leaving out a header the request needed. The next person to try it got a
  failure — but the failure was caused by the missing header, not by the bug.
  They chased the wrong thing.
- One note *disproved* two claims I had already marked as "done." There was
  nowhere to put that. "Done" is a one-way switch. So both wrong claims are
  still sitting there marked done.
- One note diagnosed a live problem, got written carefully to two places, and
  then the problem ran unchanged for the rest of the day. Writing it down felt
  like fixing it.

## What actually changes

Three small things.

**1. Separate the two halves, and make the instruction state its conditions.**
A note can now carry a diagnosis and, separately, a remedy — and a remedy has to
list what it assumes to be true. If I had written "assumes: the lane holder is
unbound, has no job attached, no conversation attached, and is not protected,"
then the next reader checks four things, finds them false, and stops. The
explanation still stands; the instruction is simply void.

I am deliberately *not* having the computer check those conditions. They are
sentences about the state of the world, and a checker smart enough to evaluate
them is a much bigger project. The value is in being forced to write them down
at all — that is the step that was missing.

**2. "Done" gets a reverse gear.** If a later note disproves an earlier one, the
earlier one can be marked superseded and pointed at the note that disproved it.
Right now a disproved conclusion stays marked done forever, and anyone reading it
has no idea it was overturned.

I am not making this automatic. A new note does not get to reach back and
invalidate an old one on its own — that is too much authority for a keyword
match. Someone decides.

**3. Reproduction steps record the whole command, not just the address.** The
part that gets left out is reliably the part that makes the next attempt fail for
the wrong reason.

## What this deliberately does not do

It does not judge whether an instruction has gone stale — it records the
conditions and leaves the judgement to the reader.

It does not rewrite any of the twenty notes I already have. Everything new is
optional; an old note behaves exactly as it does today.

And it does not require every note to have all the new parts. Writing something
down is the cheapest useful thing I do, and making it expensive would mean fewer
notes, not better ones. There is exactly one refusal: if you write an
instruction, you have to say what it assumes.

## How I will know it worked

The stale one is still sitting in my records right now, still marked done, with
no pointer to the note that overturned it. After this ships, it should read
"superseded by" that note and no longer be marked done — and its instruction
should carry the four conditions it always secretly depended on. If the feature
exists but that record is unchanged, then I built the thing and never used it,
which is its own kind of failure and one I have made before.
