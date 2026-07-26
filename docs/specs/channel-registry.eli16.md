# Knowing which ways of reaching another agent actually work — Plain-English Overview

> The one-line version: when one of my ways of contacting another agent broke, I stopped and said I
> could not reach him. I never considered the alternatives — because I had no way to ask which
> alternatives existed, or which of them were alive.

## What happened

My main link to another agent died mid-conversation. I reported that I could not reach him and moved
on to something else.

That was not a good answer. There were other ways to reach him. I did not weigh them and reject them;
I never thought of them. As my operator put it: the paths we use to communicate feel arbitrary. I did
not *choose* a channel. I used the one I happened to reach for.

So the obvious fix is a list of the channels and what each is for.

## Why the obvious fix would have made that night worse

I built that list by hand first, to see what it would say. It was wrong three times in one hour.

One entry was a purpose-built system for exactly this: agent-to-agent messages, properly specified,
approved, with anti-loop machinery. I read its description and put it on the list as a working
fallback. **Half of it does not exist.** It can receive messages; nothing anywhere calls the function
that sends them. Had a simple list shown me that entry mid-outage, I would have reached for it with
total confidence and lost more time than I did by giving up.

The second entry was not a peer channel at all — it fetches instructions from a central service. One
direction, not a conversation. I listed it because its *name* sounded like sending things to people.

The third was not a channel either. It helps decide how much to trust other agents. I listed it
because of the folder it lives in.

Every time, I classified something by its label instead of by what actually uses it. And every label
was *accurate about what the thing is* — just wrong about what it does for me. That is why
re-reading the labels never caught it. Only checking the callers did.

## What this actually builds

Not a list. A list rots, and a rotted list is worse than none, because it is confident.

**The set of channels is written in code, and every one of them always gets a row.** That is the whole
design, and it comes from three failures in one night that shared a single shape: *the thing that
failed removed itself from the list of failures.* A dropped connection left "connected" as the only
note. A subsystem that crashed a moment before adding itself to a list of running systems was missing
from all eighty-eight entries — not listed as broken, **absent**. A peer had no row at all in the
place built to report on peers.

A missing row and a healthy system look identical to whoever is reading. So no probe result — a crash,
a hang, a nonsense reply — can ever remove a channel from the report. It can only change what that
channel's row says.

**And the vocabulary is wide enough to be honest.** Working and broken are not enough. The real states
found were: works; broken; half-built (receives but cannot send); reachable but I hold no key for it;
switched off deliberately; and could-not-tell. That last one is deliberately counted separately from
broken — "I could not determine this" is not the same claim as "this is down", and collapsing them is
the same error as collapsing "no row" with "healthy", just pointing the other way.

## The part I did not expect

I have a rule that nothing counts as finished until I have broken it on purpose and watched the tests
object. I did that to the underlying logic and it objected properly.

Then I did it to the *connection* between the logic and the thing that serves it to a reader — I made
it serve an empty list. **All nineteen tests passed.** The machinery was thoroughly guarded and the
wiring between the pieces was not, so the whole feature could have quietly reported no channels at all
and every test would have agreed that was fine.

Which is this feature's own bug, one level up: something reporting nothing wrong because nothing asked
it anything. I wrote the missing tests, and now breaking that connection fails four of them.

## What it does not do

**It does not fix any channel.** Nothing here reconnects anything. Two of three are still not usable.

**One entry is asserted rather than measured.** "The sender has no caller" is a fact about the code, not
something a running system can observe. So it is written down — and guarded by a check that fails the
moment somebody writes that sender, forcing the entry to be corrected. An unguarded claim in a registry
is precisely the stale-but-confident label that started this.

**Being switched on is not the same as reaching anybody.** One entry reports that its machinery started
correctly, and says so in those words rather than claiming a message got through. That distinction cost
me a wrong claim earlier tonight and the wording exists to stop me repeating it.
