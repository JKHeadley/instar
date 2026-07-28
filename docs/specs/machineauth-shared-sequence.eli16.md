# ELI16 — machineAuth shared monotonic sequence

## What this is, in plain English

When two of your machines talk to each other, every message is stamped with a
running number (a "sequence number") that only ever goes up. The receiving
machine remembers the highest number it has seen from the other machine, and
throws away anything with a number that isn't higher — that's how it spots a
sneaky attacker replaying an old captured message.

The catch: a single machine doesn't have just one line of communication to the
other — it has several (one for the "who's in charge" lease, one for the
heartbeat, one for handing off a conversation, one for streaming the live tail,
and so on). Each of those lines was keeping its OWN running number, and each
started its counter from "the current clock time" at the moment it was set up.
Because they're set up a few milliseconds apart during startup, they started at
slightly different numbers and then drifted apart.

But the receiver only tracks ONE highest-number-seen per machine, shared across
all those lines. So the fast, chatty line (the heartbeat) quickly pushed that
number way up, and then the quieter line (the lease) — whose own counter was
sitting lower — looked like it was sending old, out-of-order messages. The
receiver rejected every one of them as a replay. The result: the standby machine
never received the "I'm in charge" announcement, so it refused to take over a
conversation.

## What we changed

We gave the whole machine ONE shared running number that every outgoing line
draws from. There's a single chokepoint that every signed message passes through,
and we made that chokepoint hand out the next number from one shared counter.
Now no matter which line sends a message, the numbers always go up in order, so
the receiver never mistakes a legitimate message for a replay.

We did it at that one shared chokepoint on purpose: it's impossible for any line
of communication — even ones added in the future — to accidentally go back to
having its own counter and re-break this. The clock-time seed is kept so that
after a restart the number is still higher than anything sent before (time only
moves forward).

## Why it matters

This was the third hidden bug in a chain that was stopping "move this conversation
to the other machine" from working. With it fixed, the standby machine can finally
receive the lease announcement, recognize who's in charge, and accept a handed-off
conversation.

## What you'd notice

Nothing on a single machine. On two machines, the replay-rejections that were
silently dropping the lease announcements stop, which is the next step toward the
conversation hand-off completing end to end.
