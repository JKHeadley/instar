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
