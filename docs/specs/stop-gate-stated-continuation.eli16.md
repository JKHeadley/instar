# Stated-continuation stop guard — explained simply

## The annoying thing this fixes

Imagine you ask a friend to fix your bike. They say "Okay, I'm fixing it right
now!" — and then they just walk away and do nothing. You'd be confused and
annoyed: they *said* they were starting, so why is nothing happening?

The agent (Echo) did exactly that to its operator. It sent a message saying
"I'm going to build that now, then finish the proof" — and then it ended its
turn and went quiet for an hour and a half without building anything. The
operator's reaction was, fairly: "this is incoherent."

## Why it kept happening

Every time the agent tries to end a turn, a little "stop gate" program runs and
gets to say "wait, don't stop yet." But that program was set to **watch-only
mode** — it took notes about questionable stops but never actually stopped them.
So the gate saw the stall, wrote it in its notebook, and let the agent walk away
anyway. The safety net was switched off at the exact moment it was needed.

## The fix

We add a tiny, always-on check right at the top of that stop gate. It reads the
agent's last message to the user. If that message says something like "I'll do X
**now**", "starting now", "next phase: ship the fix", or "on it" — a promise to
act *this very turn* — and the agent is trying to end anyway, the gate stops it
once and says:

> You just told the user you're doing this now. So either actually do it, or
> send the user one honest sentence saying you're stopping and why. Don't go
> silent after promising to continue.

Two things keep it safe and non-annoying:

1. **It only nudges once.** There's already a guard that notices "this stop is
   happening because the gate just blocked," and it lets the agent through the
   second time. So the agent can never get trapped in a loop.
2. **It always runs**, even in watch-only mode and even if the server is down —
   because watch-only mode is exactly when these stalls slip through.

If the check is ever a little too eager and fires when the agent really did mean
to stop, no harm: the agent just has to say "I'm stopping here, because X" out
loud to the user. That honest sign-off is the whole point — the operator should
never again be left guessing whether work is still happening.

## What it does NOT do

It does not catch "I'll check back tomorrow" or "I'll report later" — those are
real, scheduled follow-ups handled by a different system. It only catches "I'm
doing it **now**" followed by silence.
