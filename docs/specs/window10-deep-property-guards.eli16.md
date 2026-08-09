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

## Asking a new rule when it actually bites (2026-08-08)

Our rules say what must be true. Many of them also name the check that enforces them. **None of them
have ever said WHEN the check happens** — and that turns out to be where things go wrong.

The rule we broke on the seventh is the example. It passed every "is there a check?" test. And when I
went looking, there *were* five checks sitting at exactly the right moment — the instant an escalation
gets sent. The gate was switched on. The bad message went out anyway.

Nobody can say why, because those checks don't write down what they decided. We keep a record of a
different, simpler layer, and nothing anywhere records which of the five looked at that message or what
each concluded. So "did it fire and get overruled", "did it never fire", and "did it fire and get it
wrong" are all equally consistent with what we can see. A checkpoint that keeps no log can't be audited
— that's why the failure was invisible for a whole night.

**What changed today.** Any *new* rule added from now on has to state the moments it bites at, chosen
from a fixed list of seven that I counted from the codebase rather than made up: while you write, at
commit, at push, in CI, when a message goes out, on a schedule, or always-on. "None of them" is an
allowed answer — a rule that admits it has no teeth is honest, and we already have machinery that puts
a deadline on those. What's no longer allowed is not answering.

**What it doesn't do**, and this is in the check's own documentation so nobody mistakes it later: it
doesn't verify the answer is *true*. Someone can write down a moment that isn't really where their rule
gets violated. Forcing the question to be asked is not the same as forcing it to be answered correctly
— and a field like this, mistaken for proof, would recreate exactly the problem it was built for.

**One rule already moved off the exemption list.** The deferral rule now carries a real fingerprint,
including an honest note about the two moments it does *not* cover. It could go first because I spent
today building its guard, so I know when it bites instead of guessing. The other 86 need the same
thought, one at a time — the change that introduces a requirement can't also satisfy it 87 times.

**And a note on how this got built.** I had stopped after the measuring step, saying the design needed
more care. A guard in my own system called that out as the familiar excuse it was. It was right: being
careful means doing it carefully *now*, not later. The measuring insight was real; it just wasn't a
reason to stop.
