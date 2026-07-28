# A channel that failed at every startup, in a way three different checks could not see — Plain-English Overview

> The one-line version: one of the ways my machines talk to each other has been
> broken at every single startup. The compiler passed it. The test runner passed it.
> And the dashboard that lists broken systems did not list it, because the failure
> happened before it could be listed.

## What happened

I went looking for why two agents could not reach each other, and found a second
broken channel by accident. Every time my server starts, it prints this and carries on:

```
[mutual-ssh] initialization blocked: The requested module 'ssh2' does not
  provide an export named 'Server'
[peer-execution] disabled-grant cleanup blocked: Named export 'utils' not found.
```

Not an error. A warning, at startup, in a log nobody reads. Every boot. For as long
as the code has been that way.

## What was actually wrong

JavaScript has two ways of packaging code — an older style and a newer one. My code
is the newer style. The SSH library is the older style.

When you take something from an older-style package, you have to take the whole box
and then reach inside it. Five of my files tried to reach inside *while taking it* —
naming the pieces they wanted at the door. The older-style box does not let you do
that. The pieces are genuinely in there; the loader simply cannot see them from
outside, so it refuses at the moment the file is loaded.

Because it fails at *load* time, nothing in those files ever ran. The channel did not
work badly. It never started.

The fix is four words rearranged in five places: take the box, then reach inside.

## The part that is more interesting than the bug

I wrote a test to stop this coming back. The obvious test: load each of the five
files, check none of them throws. It passed.

Then I put the bug back on purpose to watch the test fail.

**It passed again.** Against the broken code. All eight checks green.

The test runner does not load files the way the real program does — it quietly
rewrites the older-style packages so the shortcut works. So the test was not merely
weak. It was **incapable** of ever seeing this bug, while looking exactly like proof
that the bug could not return.

The compiler is blind for a different reason: the pieces really do exist, so the
types are correct. It is only the runtime lookup that fails.

So three separate things all said fine: the compiler, the test runner, and my first
test. The only thing that ever said otherwise was a warning line at startup.

I rewrote the guard to read the source text instead. That is a cruder kind of check,
and I would normally argue against it — text checks get fooled by text that merely
*describes* the thing they are looking for. So it strips out comments and quoted text
before it looks, and there is a test that proves this file's own description of the
bug does not set it off. A cruder check that actually fires beats an elegant one that
proves nothing.

## The third place it was invisible

There is a dashboard that lists every safety system and whether it is running. Its
whole purpose is to make quiet failures loud.

`mutual-ssh` is not on it. Not listed as broken — **not listed at all**, out of
eighty-eight entries.

The reason is small and worth knowing: a system adds itself to that list *during*
startup. This one crashed a few lines earlier. So the failure removed itself from the
one inventory designed to catch failures like it.

That is the same shape as the other thing I fixed tonight, where a dropped connection
left "connected" as the only note on record. In both cases the defect deletes its own
evidence. I have written that down as its own problem rather than folding it into this
change, because it is not really about SSH.

## What this does and does not do

**It does:** make all five files load. I built the real output and loaded it the way
the real program does, and all five now load where all five previously threw.

**It does not:** prove the channel works end to end. Loading is the first door, not
the last one. Whether it then listens, finds its keys, and reaches another machine is
untested here, and I am not going to claim it because I have not watched it happen.
What I can say precisely is that it could not possibly have worked before, and that
one specific reason is now gone.

**Honest scope:** this takes the count of broken inter-agent channels from two down
to one, and only in the sense that this one is no longer dead on arrival.
