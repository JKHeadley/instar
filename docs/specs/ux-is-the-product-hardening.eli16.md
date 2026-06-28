# ELI16 — The self-stop guard must not vanish when the engine is offline

## What this is, in plain words

The agent has an always-on guard that reads every message it's about to send you and blocks a
specific bad habit: the agent talking itself out of finishing work it was told to do — "let me pause
here, I'll pick this up fresh later," "this is a good stopping point," "I'd rather not restart the
agent right now." That guard uses an AI judge to decide, by MEANING, whether a message is one of
those bail-out excuses.

On 2026-06-27 the agent sent exactly that kind of bail-out message and the guard didn't catch it. The
operator was (rightly) upset and asked: find out why, and fix it.

## What we found (the honest version)

The first guess — "the guard only matches exact phrases" — was WRONG. We proved it by replaying the
exact message from that night through the live guard: it correctly BLOCKS it. The guard's logic is
fine.

The real problem: that guard's "brain" is an AI judge, and it had been called 394 times in three days
and blocked NOTHING. The reason is that when the AI judge is unreachable (the backend was flaky that
night — that's a separate problem we're also fixing), the guard quietly **lets the message through**.
There's a small deterministic backup that still blocks leaked passwords and file paths during an
outage, but it does NOT check for the bail-out habit — that check needs the AI judge. So at the exact
moment the agent was drifting AND the judge was offline, the guard that should have caught it had
simply disappeared.

## What's new in this change

A tiny always-works backup detector for the bail-out shape (a "pause/defer this work" move plus a
self-serving reason like "huge session," "clean focused pass," restart-avoidance, or treating a
fixable local issue as a reason to stop). It plugs into the SAME degraded path the leak-backup already
uses. When the AI judge is offline and a message has the bail-out shape, the message is now HELD (and
the agent is told: the work is pre-approved, drop the pause framing and continue) instead of being
waved through.

## What already existed (so you know what we're NOT changing)

- The normal path (AI judge available) is unchanged — it already judges by meaning and already catches
  this message, as we proved.
- The leak backup (passwords/paths/commands during an outage) is unchanged.
- Your kill-switch is unchanged and now explicitly covers this too: if you ever set the gate to
  "fail-open under outage," this backup is skipped along with everything else.

## The safeguards, plainly

- The backup is NARROW: it only fires on a real "stop/defer" move conjoined with a self-serving
  reason. A genuine "I need your decision: A or B?" or "I'm waiting on the rate-limit to reset" is NOT
  held — those carry no self-serving reason.
- It only runs on the DEGRADED path (judge offline). It never touches your normal messages.
- A held message is surfaced back to the agent to reconsider — it is never silently dropped.
- It is biased to HOLD a borderline bail-out (the safe direction): making the agent re-think costs
  nothing; letting a bail-out through is the exact failure we're fixing.

## What you actually need to decide

Nothing is required — this strictly ADDS protection on a path that currently fails open, and it has
your existing kill-switch. The one judgment call (documented as an open question in the spec): should
a message that BOTH floats a bail-out AND asks you a question still be held when the judge is offline?
Current design: yes, hold it (the agent can re-ask without the bail-out framing). If you'd prefer the
opposite, that's a one-line change.
