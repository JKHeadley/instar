# Slack reconnect crash guard — explained simply

## The everyday version

Your laptop sleeps and wakes all day. Every time it wakes, the agent has to reconnect its live
connection to Slack — like re-establishing a phone call that dropped. There's a rule that the agent
must say "got it" (an acknowledgement) the instant Slack sends it a message.

The bug: sometimes a message arrived in the split-second WHILE the connection was still being
re-established — the line wasn't fully open yet. The agent tried to send its "got it" down a line
that wasn't ready, which threw an error. And because that error happened in a background handler
nobody was watching, it bubbled all the way up and **crashed the entire agent** — taking down its
databases and everything else — just because one Slack acknowledgement couldn't be sent.

## What we changed

Two safety nets:

1. **At the source:** before sending the "got it," the agent now checks that the line is actually
   open. If it isn't (mid-reconnect), it skips the ack — and that's fine, because Slack simply
   re-sends the message a moment later. We also wrapped it so even a split-second timing fluke can't
   throw.

2. **As a backstop:** the agent already had a short list of "minor errors that should never crash the
   whole thing" (like harmless web-response races). We added this Slack reconnect hiccup to that list.
   So even if some other Slack timing glitch slips through, the agent logs it and keeps running
   instead of crashing and closing its databases.

## Why it's safe

The "minor errors" list is kept very tight — only specific, isolated, self-healing errors go on it.
A genuinely serious error (like a database problem) is NOT on the list and still crashes-and-restarts
as before, which is the safe thing to do. We pulled that list into its own small piece of code and
tested it both ways: the Slack hiccup and the known harmless races are treated as recoverable, while
made-up serious errors are still treated as fatal. And skipping a Slack ack loses nothing, because
Slack re-delivers anything it didn't hear "got it" for.
