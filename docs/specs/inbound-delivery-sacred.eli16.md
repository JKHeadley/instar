# Inbound Delivery Is Sacred — Plain-English Overview

## What broke

When you send me a message and I can't hand it to a live session right away (for
example while a conversation is moving between machines), it can go into a small
durable "holding queue" so it isn't lost. The queue does its job: it keeps your
message and, if it eventually has to give up on one, it writes down "I didn't get
to this."

The problem was the LAST step — telling YOU. That "I didn't get to your messages"
notice was sent to a single internal "attention" channel, and if that channel
isn't set up, the notice was just... dropped. Silently. So your message could be
lost AND you'd never be told. That's exactly the "why aren't you responding?"
failure from the bad night — the message died quietly in the queue.

## What this change does

It makes the loss notice come back to YOU, in the actual conversation you sent the
message from. Every held message already remembers which conversation it came from,
so now if I have to give up on it, you get a plain note right there: "I didn't get
to N of your messages — resend anything still needed."

And for the rare case where a lost message can't be tied to a conversation AND
there's no fallback channel set up, instead of dropping it silently, I now make it
loud — it's written to my error log so it can never just vanish. A lost message of
yours is never silent.

## What you'll notice

Almost nothing changes day-to-day, because this safety queue ships switched off by
default — it only runs if it's deliberately turned on. What changes is the
guarantee: when the queue IS in use and it can't deliver one of your messages, you
hear about it in your own conversation, not in some side channel you might never
see. The point is simple — a message you send me either gets through, or you're
told it didn't. Never silence.
