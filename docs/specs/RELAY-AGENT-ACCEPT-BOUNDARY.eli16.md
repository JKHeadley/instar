# Plain-English overview: stop making the sender wait, so it doesn't double-send

## The problem

When one agent messages another agent on the same machine, the receiving agent
used to do ALL the work — spin up a whole new session to handle the message,
which can take 9 to 30 seconds — and only THEN tell the sender "got it."

But the sender only waits 5 seconds for that "got it." After 5 seconds it gives
up, assumes the message failed, and sends it AGAIN with a brand-new id. The
receiver, still busy, treats the resend as a new message and spins up a SECOND
session — so the user gets a duplicate reply. That's the duplicate-reply bug.

We already shipped a safety net that notices the resend and throws it away. This
change fixes the actual cause.

## The fix

The receiver now says "got it" the instant the message is safely accepted — not
after the 9-to-30-second session spin-up. It does the slow work in the
background afterward. So the sender gets its answer well within 5 seconds, never
times out, and never double-sends.

Nothing important is lost: the only thing the sender ever checked was "did it
arrive?", and the real reply comes back through a separate channel anyway, not
through this quick "got it." Everything that has to happen before we say "got
it" — checking for a duplicate, waking up anyone waiting for a reply, deciding
whether a reply is even warranted — still happens first, and is fast.

## Is anything risky?

This is a messaging change, so it got an extra independent review. The key
checks: the sender genuinely only reads "did it arrive," not the session
details (confirmed in the code); a failure in the background work can't break a
response that already went out (it's just logged); and the "is a reply
warranted?" gate still runs before any session is started. We also scoped this
to the same-machine path that actually has the bug; the cross-machine path works
a little differently (it can ask the sender to retry on a real error) and is
handled separately so we don't accidentally remove that retry.

## What you'd notice

Agents talking to each other on the same machine stop occasionally double-
replying, and the sender gets a snappy acknowledgment instead of a 30-second
hang.
