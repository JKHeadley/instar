# ELI16 — Why your sessions stopped pinging you about a "throttle" that wasn't real

## What was going wrong

The agent has a safety helper that watches your chat sessions. If a session gets
temporarily blocked by the AI provider (a "server is busy, slow down" throttle), the
helper waits a bit and then nudges the session to continue — so your conversation
doesn't silently die. Good idea.

The bug: the helper decided a session was "throttled" by reading the last few lines of
the session's screen and looking for the throttle message. But a session that had
**already finished its work** sits quietly at a prompt with that old throttle message
still on screen. The helper saw the old message, assumed the session was stuck, and
tried to "rescue" a session that was actually just *done*. A finished session never
produces new output, so the helper's rescue never "worked" — it kept retrying six
times and kept sending you messages like *"The temporary server throttle should have
cleared — please continue where you left off."* You'd see those pile up even though
nothing was actually wrong. And because the helper code is shared by every agent, the
same false alarm showed up on other agents too (this is what made it scary — it wasn't
one agent misbehaving, it was the shared logic).

Two more gaps made it worse: when a session finished, nothing ever told the helper to
stop watching it, so finished sessions lingered as "rescue targets" forever; and a
separate background check that asks "how much quota do I have left?" was logging a
scary "rate limit!" warning every time its meter endpoint hiccuped, even though that
wasn't a real limit.

## What we changed

1. A finished or killed session can no longer become a rescue target — the helper now
   checks "is this session actually still running?" before doing anything, and bails
   out silently if a session finishes mid-rescue.
2. When a session ends, the helpers are told to stop watching it immediately.
3. The noisy "rate limit!" log only fires now when there's a *sustained* problem, not
   on a one-off hiccup.

## The part that prevents this from happening again

The real win isn't just this one fix — it's a new way to **catch this whole class of
bug before it ships**. The agent already had a test system that talks to itself through
real Telegram (as if it were you) and checks the replies. But it could only check
"did the agent say the right thing?" — it couldn't catch the agent saying something it
*shouldn't*. We taught it to do exactly that: a test can now drive a real conversation
and then prove that **no unwanted background message** (like the false throttle nudge)
shows up over the next stretch of time. If a future change brings the bug back, that
test fails and the "is this done?" gate blocks the release. We proved this works: a
deliberately-broken version gets caught and blocked.

## What it means for you

You'll stop getting phantom "throttle cleared, continue" messages that don't match
anything actually happening. Real throttles are still handled — genuine rescues still
run. And this class of "a background feature spams you by mistake" is now something the
test system can catch before it ever reaches you.
