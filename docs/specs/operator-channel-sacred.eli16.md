# The Operator Channel Is Sacred, in plain English

## The one-sentence version

A safety check was allowed to silently eat the operator's own messages when it guessed wrong — and
because the "how to recover" instruction went back through that same broken check, the operator got
trapped in a loop and locked out of their agent entirely. This adds the missing rule that makes that
impossible, and fixes the check that broke it.

## What happened

Every message you send the agent on Telegram first passes through a "message sentinel" — a guard
meant to catch you saying "stop everything!" so it can halt the agent instantly. To decide, it asks
a language model to classify your message. The problem: when that classifier guessed wrong and
labeled an ordinary message (even "Testing") as a "pause" command, the guard **swallowed the
message** — it never reached the agent — and replied "Session paused. Send a message to resume." Your
next message hit the same wrong guess and got swallowed too. And "send a message to resume" ran
through the very same broken guard, so there was no way out. You were locked out of your own agent.
A machine overload made the classifier guess wrong more often, but the real flaw was structural: a
fragile guesser was allowed to throw away your messages.

## The missing rule

We already have a rule that says safety checks on OUTGOING messages should "fail closed" (when in
doubt, hold the message) so secrets can't leak. But nobody wrote the opposite rule for INCOMING
messages from you: **your channel to the agent is sacred, and a guard on it must fail toward
DELIVERING your message, not eating it.** A missed "pause" is harmless (pausing is a politeness, not
a safety feature); a swallowed message can cut you off completely. So:

- A fragile guesser may never throw away your message on a low-confidence hunch. Only a clear,
  unambiguous signal (you literally typed "pause"/"stop") or a very high-confidence read may consume
  a message; anything less gets delivered to the agent anyway.
- A "how to recover" instruction must never route back through the thing that's broken — otherwise
  it's a trap.
- One wrong guess must never be able to lock you out: if the guard just paused you and you keep
  sending normal messages, it automatically backs off and lets them through.

## The fix

The message sentinel is changed to honor that rule: a "pause" only swallows your message if you
actually typed a pause/stop command or the classifier is highly confident it's a short control
directive. Any uncertain guess delivers your message instead. And a circuit-breaker watches for the
exact lockout pattern — if it paused you and you keep talking, it stops pausing and lets you through.
The genuine "stop!" emergency path is untouched, so you can still halt the agent instantly.

## Then: find every other place with this blind spot

This same shape — a fragile check sitting on a critical path with the power to block it, failing in
the wrong direction — may exist elsewhere in instar. After this fix ships, a careful (paced, so it
doesn't re-overload the machine) audit of the whole codebase hunts down any other gate that can
block a critical path on a weak signal, and applies the same rule.

## What you decide

Whether this is the right rule and the right fix. There's no setting for you to manage — the message
sentinel was already turned off as an interim safeguard; this fix makes it safe to turn back on,
because it can no longer swallow your messages on a wrong guess.
