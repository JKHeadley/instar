# ELI16: Why the safety checks stopped working under load — and the fix

## The setup

My server constantly makes little AI judgment calls to keep things safe and
coherent: "is this outbound message about to leak a command?", "is this agent
trying to quit without a good reason?", "does this reply contradict what we
promised?" Each of those is a quick call to the AI model.

All of those calls share ONE account with Anthropic. When too many calls happen
too fast, Anthropic says "slow down" (a rate limit — like a busy signal). To
avoid burning money hammering a busy signal, my server has a "circuit breaker":
when it hears the busy signal, it flips a switch that pauses ALL AI calls for 15
minutes.

## The bug

Here's the problem. When the breaker is flipped and a safety check can't get its
AI answer, the check just... gives up and says "sure, allow it." That's called
"failing open." It seemed safe-ish — don't block the user just because the AI is
busy.

But think about WHEN the breaker flips: exactly when the system is busiest and
most stressed. So at the precise moment things are most likely to go wrong, every
safety check quietly switches off and waves everything through. The logs literally
showed "Stop allowed without authority ruling" and "message review failed — fail
open." The guards were asleep on the job exactly when they mattered most.

## The owner's instruction

Justin's call: it's fine if things take a bit LONGER when we hit a busy signal —
as long as the important checks stay correct. Better to wait 30 seconds and get a
real answer than to instantly wave through something dangerous.

## The fix

We split the AI calls into two kinds:

**Important checks** (the outbound-message gate, the "are you quitting for a real
reason" gate, the high-stakes coherence reviewers): when the breaker is flipped,
these now WAIT — up to a bounded amount of time — for the busy signal to clear,
then get their real answer. Slower, but correct. The waits are capped so they can
never hang forever (the quit-gate waits only 8 seconds, because it's on the
agent's critical path; the message gate can wait up to 2 minutes).

**Best-effort checks** (background observability stuff — commitment detection,
tone nitpicks): these keep instantly giving up when the breaker is flipped. On
purpose! They're the high-volume callers that TRIP the breaker in the first
place, so having them step aside lets the breaker recover faster and frees up the
scarce "is it clear yet?" probe for the important checks.

We also taught the breaker to read a hint: if the busy-signal message says "try
again in 30 seconds," the breaker only pauses 30 seconds instead of the full 15
minutes. (It can only read hints that show up in the text — the real HTTP header
is invisible to us because we call the AI through a command-line tool, not a
direct web request — so when there's no hint it falls back to the old 15-minute
wait.)

## How we made sure it's safe

A caller that doesn't ask to wait behaves EXACTLY like before — instant give-up —
so nothing that wasn't explicitly upgraded changed at all. And the waiting logic
is careful that when the busy signal clears, only ONE check actually pokes the AI
to see if it's back; everybody else waits for that one answer, so we don't all
rush the door at once and re-trip the breaker. 27 tests with a fake clock prove
every path: waits-and-proceeds, gives-up-at-the-deadline, and the one-pokes-many-
wait crowd behavior.

## Why it matters

Before: the safety net had a hole that opened exactly when you were falling.
After: the important parts of the net hold — they pause and catch you a moment
later instead of letting you through. Slower under stress, but actually safe.
