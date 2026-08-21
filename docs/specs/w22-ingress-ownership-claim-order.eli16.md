# Plain-English overview — a machine stops signing for post it is only passing along

## The setup

This agent can run on more than one computer. Each conversation belongs to one of them at a time. If
a message arrives at a computer that does not own that conversation, that computer does the sensible
thing: it hands the message to the one that does. Delivery works.

## What was wrong

Before handing the message on, the receiving computer also wrote itself an entry in its own arrivals
book — effectively signing for the message. That entry is meant to be closed out when the same
computer answers. But it never answers, because it passed the message along. So the entry sits there
forever, half-finished.

We found two real examples on one machine after a conversation moved away from it. One entry was
written four minutes after the move and marked abandoned. The other was written eleven hours later
and is still sitting open three days on. Both are the paperwork left behind by deliveries that
actually succeeded.

## What changes

One check, before the entry is written: if this computer knows the conversation belongs to another
one, it skips writing the entry. It still passes the message along exactly as before. Nothing about
delivery changes.

## What was deliberately NOT done, and this is the important part

The first version of this change refused the message outright and told the sender to go away. That
looked tidier and it was wrong. Following what the code actually does afterwards showed that the
non-owning computer is the thing that relays the message onward — so refusing would have removed the
delivery and kept only the refusal. The sender would have retried against the same computer, been
refused again, and eventually given up, losing the message.

That version was withdrawn during review, before it became a pull request. The shipped version blocks
nothing at all: it only declines to write a piece of bookkeeping it has no business writing.

## The safeguards, in plain terms

If the ownership information cannot be read for any reason, the computer behaves exactly as it does
today — it writes the entry and passes the message along. An unreadable ownership record can never
cause a message to be refused or dropped. When this agent runs on only one computer, the check never
engages and behaviour is identical to today.

Existing half-finished entries are not cleaned up by this change. That is a separate problem with a
separate cause, and bundling it in would hide which change did what.

## What this does not claim

This is a correction reviewed by a human before it lands. It is **not** proven effective in the
formal sense this project uses that word — the instrument that would let anyone call a guard properly
fixed exists only as a draft document. The honest label is review-grade.

There is also a condition on this one: the tests that prove a non-owning computer skips the entry AND
still passes the message along could not be run on the build machine, which refuses to let test code
open a network port. They run in the pull request's own checks. Until those checks execute them and
pass, the central claim of this change is written down but not demonstrated, and it should not be
treated as verified.

## What the reader actually needs to decide

Whether a computer should sign for post it is only forwarding. The cost of the change is one lookup
before a bookkeeping write; the cost of leaving it is a slow accumulation of half-finished entries
that make the arrivals book untrustworthy — which is exactly how a night of investigation ended up
chasing a stuck entry that turned out to be a symptom rather than a cause.
