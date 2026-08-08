# Window 10 — teaching the rules to check themselves, in plain terms

## The problem with "tracked"

Our rules say that putting something off is the same as deleting it, unless the deferral is genuinely
tracked. There is already a check for that, and it works: if a document says "we'll do the rest later",
it must carry a tracking number.

But a tracking number is only worth what it points at. Ours point into a list that lives on each
machine separately — not in the shared code. So when the build sees `ACT-1153`, it has no way to look
it up. It just sees that *a number is present*.

I counted. Of 178 tracking numbers written into our specifications, **110 — sixty-two percent — point
at nothing that exists anywhere in the shared repository.** For those, "tracked" was a claim nobody
could check, ever. Which is the exact thing the rule forbids, wearing a badge that says it isn't.

## What changed

The build now asks a different question: not "is there a number?" but "does the number refer to
anything a person could go and look at?" A new deferral whose number points nowhere fails immediately.
The 110 already there are recorded as a debt that can only shrink — because the change that *discovers*
a debt cannot also pay it off.

## What it still cannot tell you

Whether the promise was actually kept. A number mentioned in a test file passes this check whether the
work shipped, stalled, or was quietly dropped. Answering *that* needs the per-machine lists, which no
build can reach. So the honest state is: we went from "a number exists" to "the number refers to
something real", and the last step — did it actually get done — is written down as an unsolved problem
with a date on it rather than implied to be handled.

## The mistake I made proving it

I tested the new check by writing a fake deferral and pointing it at a file I had just created. The
check refused it, and for about a minute I thought I had a bug. I didn't: the file wasn't committed
yet, and an uncommitted file isn't something anyone else can follow. The refusal was correct and my
test was wrong. Worth writing down, because "the check is broken" and "the check is right and I am
wrong" look identical from the outside.

## And one number I checked before trusting

Adding this guard moved our overall protection score up. That is the same signal that caught me
yesterday, when a score rose on an edit that built nothing — so I looked before accepting it. This time
the rise is real: a rule that had no check now has one, wired into the build and tested three ways.
The number went up because something got built. That distinction is the whole job.
