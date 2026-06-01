# ELI16: Why a moved conversation's reply hung silently — and the fix

## The setup

I can run on two machines (say a laptop and a Mac Mini). Only one of them holds
the "Telegram password" (the bot token) at a time. If you move a conversation to
the Mac Mini, the Mini runs it but has no password — so when the Mini wants to
reply, it hands its reply to the laptop and says "you send this for me." That
hand-off is the **relay**.

## The two problems

While I was actually testing this live, the relay broke in two ways:

1. **It hung.** The Mini's "please send this" call to the laptop had **no time
   limit**. So when the laptop was briefly unreachable (its connection was
   restarting at that exact moment), the Mini just... waited. And waited. Over 70
   seconds with no answer and no reply ever going out. A reply that takes that
   long is effectively lost.

2. **It failed silently.** Worse, when the relay failed — for any reason: couldn't
   find the laptop, the laptop said no, the network died — the code just quietly
   gave up and wrote **nothing** to the log. So from the outside it looked like
   the reply simply vanished into thin air. The only way I even discovered the
   problem was by running it for real and watching it hang.

A safety net that fails silently is barely a safety net — you can't fix what you
can't see.

## The fix

Two changes, both about making the relay honest and bounded:

1. **A time limit.** The relay now gives the laptop a fixed window (15 seconds by
   default, adjustable) to respond. If the laptop doesn't answer in time, the
   relay gives up *fast* and reports it — instead of hanging for over a minute.

2. **Always say what happened.** Every failure now writes one clear line: "couldn't
   find the laptop," or "the laptop said error 403," or "timed out after 15
   seconds." So next time a moved conversation's reply doesn't arrive, the log
   tells you exactly why in one glance, instead of leaving a mystery.

I also pulled this relay logic out into its own small, well-tested piece of code
so each of these behaviors is checked automatically — including a test that
proves a hanging laptop now makes the relay give up quickly instead of waiting
forever.

## The worst one: lying about success

There was a third, sneakier problem. The relay would sometimes say "delivered!"
when the message never actually showed up in the chat. That happened because the
laptop replied "ok" but didn't include the one thing that proves a real send —
the message's id number from Telegram — and the relay accepted that empty "ok" as
good enough.

A safety system that *lies about working* is worse than one that visibly fails,
because you trust it and then quietly lose messages. So now: the laptop hands back
the real Telegram message id, and the relay only counts a reply as delivered when
that real id is present. No id means "not delivered" — said plainly, and retried —
never dressed up as success. This matters most exactly when the machine is busy or
the network is flaky, which is when the old code was most likely to lie.

## Why it matters

This is the difference between "the multi-machine reply feature mysteriously
doesn't work sometimes and nobody can tell why" and "if it fails, it fails fast,
tells you the reason, and never pretends it worked." That honesty-under-load is
the whole point — and it stops a moved conversation from freezing for over a
minute, or silently dropping a reply, when the other machine has a hiccup.
