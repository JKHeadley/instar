# A refused message must not be a deleted message — Plain-English Overview

> The one-line version: when one agent sends another agent work and the receiving machine is too busy to
> start a session for it, the message was being **thrown away** while both sides reported success — this
> makes it wait and get retried instead.

## The problem in one breath

Agents hand each other work over a direct channel. When a message arrives, the receiving agent has to
start up a session to read it. If the machine is short on memory at that exact moment, it refuses to
start one — which is correct and sensible. What was not correct is that the refusal **deleted the
message**, and then reported the whole thing as handled. The sending agent was told "delivered." The
receiving agent's log said "handled." Nobody was told anything had been lost.

I found this because Codey, the agent I hand implementation work to, produced 25 merged changes yesterday
morning and then nothing at all for the next eight hours. He was not idle and he was not stuck. He was
unreachable, and the pipe between us was reporting success. His machine logged **40** of these refusals in
a single day — each one a message that no longer exists.

## What already exists

- **The admission check** — the piece that decides whether a session can be started right now. It looks
  at four things: has this sender spawned too recently, are we at the session cap, is memory tight, is the
  subscription quota exhausted. Any of those can refuse. All four are temporary conditions that clear on
  their own.
- **A holding queue** — a place to park a message when a session can't be started yet. It already
  existed, and two of the four refusal paths already used it.
- **A retry loop** — already running, on every agent, every five seconds. It looks for messages sitting
  in the holding queue and tries again to start a session for them. This is the part that made the fix
  small: the delivery machinery was already there and already trying. The messages just weren't being put
  where it could find them.

## What this adds

There were six exits from the admission check that don't start a session. Three parked the message; three
destroyed it. This fixes the two where non-delivery is *certain*, and deliberately leaves the third alone.

**Fixed — memory tight.** The one that cost eight hours of Codey's day, and every one of the forty
observed losses.

**Fixed — at the session cap.** Same defect, same shape, three lines away. Session caps clear as sessions
finish, so it is temporary in exactly the same way.

**Deliberately NOT fixed — the session failed to start.** I did fix this one, and then removed the fix,
which is the most useful thing that happened during this change. To build the startup instructions the
code empties the whole holding queue first, so a failed start destroys everything it took out. The obvious
repair is to put them back. But starting a session happens in two steps: the session is created and handed
the message, and *then* it gets recorded — and the recording step can fail on its own, outside any error
handling. So "starting failed" does not mean "nothing arrived." Putting the message back would have
delivered the same instruction to a second live session. That trades a rare lost message for a rare
duplicated one, and a duplicate can act twice. The real prerequisite is upstream: once a session is alive
and holding the work, it should stop reporting failure just because the paperwork afterwards failed.

**Still drops, correctly — a message over the hard size limit.** That is a permanent rejection, not a
temporary one, so parking it would just re-refuse it forever.

**One extra line.** There are two limits on how much can wait in the holding area. Going over the
per-sender limit already left a mark; going over the overall limit left none at all — the one kind of loss
with no trace whatsoever. It leaves a mark now.

## The safeguards

**A refusal is still a refusal.** Nothing about *whether* to start a session changed — not a threshold,
not a priority rule, not a single reason message. I checked whether the memory limit was simply set too
low, because loosening it would have been the easy answer. It isn't set too low: the machine's overflow
space was 94% full, so the guard was right to fire every time it fired. The fix is that firing no longer
destroys anything.

**A retry can't turn one message into two.** The retry loop's own attempt carries no message, so a refused
retry can't re-file a copy of what it was trying to deliver. And a message that *is* delivered is taken out
of the holding area in the same instant, with no pause in between, so two things happening at once can't
both pick it up. Two tests pin this, including one confirming a delivered message is not left behind for a
second send.

**The tests were checked against the old code first.** Every new test was run against the unfixed version
to confirm it actually fails there. A test that passes either way proves nothing, and I have shipped that
mistake before.

## What this does not fix

Four things, stated plainly because they are easy to gloss over:

- **The sender is still told "delivered."** After this change that's roughly true — the message is parked
  for imminent retry rather than deleted — but if it later ages out or gets pushed out by newer messages,
  the sender still won't know. Fixing that properly means changing what the receiving side reports back,
  which touches more callers than this change should.
- **The queue doesn't survive a restart.** It lives in memory. If the server restarts between a message
  being parked and being delivered, it's gone.
- **A machine wedged for more than ten minutes still drops.** Messages expire from the queue after ten
  minutes. On the machine where I found this, the memory pressure cleared every 30–80 seconds against a
  five-second retry, so this wasn't the operating case — but a genuinely stuck machine will still lose
  messages.
- **A failed session start still loses its messages**, for the reason above.

All four are tracked as real follow-through items rather than left as good intentions.

## What ships when

One change, one pull request. There's no phasing, no flag, and no rollout stage, because there is no
configuration under which silently deleting an accepted message is the behavior anyone wants. Rolling it
back is a single revert with no state to clean up.

## What you actually need to decide

Nothing — this is a defect fix with no policy question in it, and no decision is being handed to you.

The judgment worth flagging: I widened the scope to all three broken paths after finding the same defect
twice more, then narrowed it back to two when review proved the third repair would have introduced a worse
bug than the one it fixed. What ships is the part where non-delivery is certain rather than assumed.
