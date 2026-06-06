# ELI16 — Duplicate-Message Suppression

## The problem

You flagged it and the logs proved it: the same status message went out to you
THREE times — two of them byte-for-byte identical, 13.5 minutes apart. That's me
sending the same thing twice, which is exactly as annoying as it sounds.

Why did the existing safeguards miss it? There was a guard that catches "the
exact same send retried" — but these were two SEPARATE sends with the same
words, 13 minutes apart, so it didn't count them as the same. And the smarter
content-check was being skipped on the very paths these went through (status
relays, cross-machine).

## What this fixes

I added a dead-simple, reliable check right where messages go out: if I'm about
to send you the SAME message text in the SAME topic that I already sent in the
last ~15 minutes, the repeat is dropped — you just don't get pinged twice. The
first one still goes through normally.

It's deliberately careful so it never over-corrects:
- **Short acks are exempt.** If you send me two things and I reply "Got it" to
  both, you still see both — only longer, substantial messages get deduped.
- **Per-conversation.** The same text in a different topic still sends.
- **I can force a repeat** when I genuinely mean to (rare) with an explicit flag.
- **A failed send isn't remembered**, so a real retry of something that didn't
  go through is never swallowed.

Tested both ways: identical status 13 min apart → second one dropped; two
different messages → both sent; two short acks → both sent; cross-topic → sent.
Run through the real send path, not just in isolation.
