# Relay-funnel accept-boundary — explained simply

## The everyday version

Imagine you text a friend "can you grab milk?" Your phone waits for them to actually go to the
store, buy the milk, and come back before it shows your text as "delivered." That's absurd — and if
your phone gives up waiting after 10 seconds and re-sends the text, your friend ends up with two
identical requests and buys milk twice.

That's almost exactly what was happening between two agents on different machines. When agent A
sends a message to agent B, B has to spin up a whole work session to handle it — which takes 9 to 30
seconds. But A only waits about 10 seconds for B to say "got it." So A would give up, assume the
message failed, and send it again with a fresh ID. B, not recognizing the resend as a duplicate
(different ID), would spin up a SECOND session and reply twice. The user saw the agent answer the
same thing twice.

## What we changed

B now says "got it" the instant the message arrives and is verified — *before* doing the slow work.
Then it does the work in the background. So A never gives up, never re-sends, and B never replies
twice. The actual reply still comes back through a separate channel, so nothing is lost by replying
"got it" early.

## Why it's safe

We checked exactly who sends to this door: both senders only look at whether the response says "ok,"
and they give up after ~10 seconds. Since the old code couldn't even produce its answer until 9-30
seconds in, those senders never actually saw the detailed error response the old code returned —
they'd already given up. So switching to "say ok immediately" breaks nothing: no sender was relying
on the slow detailed answer.

This is the exact same fix we already shipped and proved for agents on the *same* machine (it worked
there). This change applies it to agents on *different* machines, which was deliberately left for a
follow-up. We didn't need to add any duplicate-catching net either, because removing the re-send
removes the cause. The one thing to know: if the background work genuinely fails (not just runs
slow), it gets logged instead of automatically retried — a rare case, and the same trade the
same-machine fix made.

We proved it with a test that holds the slow work open and checks the "got it" response comes back
first, then lets the work finish — plus a test that a background crash still leaves the sender with a
clean "ok."
