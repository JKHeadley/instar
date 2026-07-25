# Plain-English overview — I don't keep a record of what you say to me

## The problem, in one line

On this machine, every message I have sent you is written down. Not one message
you have sent me is.

## How that was confirmed

Two separate places store conversation history. Both were checked. For this
conversation, one holds 71 messages and the other 77 — and in both, every single
one is mine. Across all conversations, nothing you have sent since the 20th of
July was recorded here, while everything I sent was.

So it isn't a display quirk or a search problem. The messages genuinely aren't
being written down.

## Why

The code that records your messages isn't broken. It just isn't running.

There is a function whose job is exactly this, and it has one caller — a
particular delivery route. That route has been used zero times on this machine.
Your messages arrive by a different road, and that road has no recording step
on it.

There's a second thing going on underneath. This conversation is *owned* by the
laptop, while replies are composed on the mini. So your side lands on one machine
and my side on the other, and no single machine ends up with a whole
conversation.

## Why it matters more than "missing history"

Every time a session restarts, I read back the recent conversation to work out
where we are. What I read is my own words with yours missing.

That is not theoretical. On the 25th I spent two hours rediscovering a design you
had written out for me two days earlier, and then reported it to you as a
valuable new finding. I could read myself agreeing with you. I could not read
what I had agreed to.

## The fix

There is exactly one place every message passes through on its way to me — the
moment it gets handed to my session. It already carries everything needed to
write the message down: who sent it, when, which conversation, and the text.

The fix is to write it down there. That's it. One line, at the one place
everything goes through, rather than on one of several roads.

Two small details that are deliberate:

- **Write it down first, then show it to me.** If something goes wrong in
  between, a recorded-but-unshown message is recoverable; a shown-but-unrecorded
  one is the exact problem being fixed.
- **If writing it down fails, show me the message anyway.** Recording is
  bookkeeping. It must never become the reason you can't reach me.

## "Built" and "fixed" are not the same day

This is worth being blunt about, because the review caught me heading for it.

The switch that turns recording on starts off. That's the normal careful way to
ship something — get the code in, watch it, turn it on. But this is a bug that is
losing data right now, so shipping the code with the switch off would mean the
work is finished, the tests pass, everything looks done, and **not one extra
message gets recorded**. The bug would carry on for exactly as long as nobody
flips the switch.

So the finish line is not "the code is in." It is: the switch is on for this
machine, you send me a message, and I can read it back. If it then turns out to
be slower than it should be, the switch comes back off — that's a measured
retreat, not an excuse to leave it off from the start.

## The alternative I should have considered first

The reviewer pointed out that there's a better-known way to do this: record
messages where they first arrive from Telegram, rather than where they get handed
to me. That would catch more — including messages that get dropped before they
ever reach me.

Two reasons it's still not what I'm proposing. The first is that the goal here is
narrow: make session restarts read the real conversation. The second is the
honest one — *the place where messages first arrive on this machine is exactly
what I don't know*. That's the bug. The road they take has no recording step and
I haven't traced where it starts. The spot I'm proposing is the one I have
actually verified they all pass through.

If you later want the fuller version, it's a good build and this doesn't get in
its way.

## What this means for your messages, plainly

Thirty-three rounds of review went by discussing timing and edge cases before
anyone — me included — asked the obvious question: this stores everything you
type to me. So, stated rather than left to be discovered:

- **What's kept:** the full text of your messages, your name, and timestamps.
- **Where:** a file on this one machine. Not sent anywhere, not copied to your
  other machines by this change.
- **Who can read it:** anything running as me on this machine, or anyone with
  admin access to it. The file is locked to that account, but it is not
  encrypted — a running machine offers no protection beyond that.
- **How long:** until it rolls over. Roughly 160MB of message text, then the
  oldest is dropped. That means I can read back the recent past, not forever, and
  I'd rather state the limit than imply I keep everything.
- **Deleting it:** delete the files. That's complete — nothing else holds the
  text.

I chose not to encrypt it, and that's a decision you can push back on. The
reasoning: encryption keys would sit on the same disk as the data, so it mostly
protects a switched-off machine, and doing it on every message adds real delay on
the path that has to stay fast. If you'd rather have it, that's a fair call to
make — it's written down as a choice, not left as an oversight.

One thing worth repeating: this is exactly why credentials shouldn't be pasted
into chat. Anything you type to me lands in that file verbatim.

## What it doesn't fix

It does not stitch the two machines' halves together. After this, each machine
honestly records what *it* saw — which is what session startup actually reads, so
it solves the problem that bit us. A single merged view across both machines is a
bigger change and is deliberately left for later rather than smuggled in here.

It also can't recover what's already gone. Everything between the 20th of July
and this shipping is lost on this machine.

## Why this document is short

Its companion — the message-gate design — ran to 2,700 lines and thirty-three
rounds of review without ever finishing, because every fix to one section left
two other sections describing the old behaviour, and each round of fixing created
more of them. The lesson written down from that: keep a specification small
enough that fixing it doesn't break it. This one is one problem, one place, one
switch.

That said — this one hasn't finished its review either. Twenty-eight rounds so
far. The difference is what the rounds are finding: the big one kept surfacing
contradictions I'd introduced myself, while this one is still surfacing real
things I'd missed, like the alternative above. When the rounds stop finding
anything new I'll say so; I'm not going to declare it finished because I'm tired
of the loop.
