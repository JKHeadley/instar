# ELI16 — The message router stops re-learning the same bad news

## The problem

When Echo runs conversations across two machines, each message gets forwarded
to whichever machine "owns" that conversation. If the owning machine is slow
or down, the router retries a few times (about 4.5 seconds of trying), gives
up, and re-homes the conversation on a healthy machine. Sensible — except the
router learned NOTHING from it. The "this machine looks bad" signal existed in
the code but was never plugged in. So if you had ten conversations on a
struggling machine, all ten independently paid the same 4.5-second discovery
tax, message after message, because the only health check the router consulted
was "is it sending heartbeats?" — which a slow machine keeps passing.

Also found while in there: the router kept a small bookkeeping entry for every
conversation it ever routed, forever (a slow leak), and its "queue this
message for later" option turned out to be wired to nothing — queued messages
just relied on the messaging platform re-sending them.

## The fix

A small circuit breaker, plugged into the hook that was always there: when
deliveries to a machine keep failing, that machine is marked "suspect" for 30
seconds. During that window, every conversation it owns skips the retry tax
and goes straight to the existing re-homing path. Any successful delivery
clears the mark instantly. After 30 seconds the router tries the machine for
real again — so a recovered machine gets picked back up quickly.

The independent reviewer earned their keep AGAIN: my first version extended
the 30-second window every time a new message arrived — meaning a busy machine
that had already recovered could stay written off forever (the more traffic,
the longer the wrongful exile — exactly backwards). The reviewer reproduced
it, fixed it (the window now expires on schedule no matter the traffic), and
added the regression test. The bookkeeping leak is also fixed.

One thing deliberately NOT decided here: what to do with messages during the
suspect window — re-home fast (today's behavior, kept) or hold-and-wait for
stability. That's an operator-policy choice that needs a real message queue
built first; it goes to Justin as options.

## What changes for you

A struggling machine costs one discovery instead of one per conversation per
message, recovered machines come back into rotation within 30 seconds, and
pinned conversations don't get moved by a brief blip.
