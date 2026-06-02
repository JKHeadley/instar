# ELI16 — Giving the agent a real clock

## The one-sentence version

An AI agent has no built-in sense of time — it only knows what the system tells
it each turn — and right now the system forgets to tell it during long
autonomous work, so the agent loses track of how long it's been running and how
much time is left. This gives it a real, always-on clock.

## What's actually going on

When you chat with the agent, a small hook stamps the current wall-clock time
onto your message before the agent reads it. So on a normal back-and-forth, the
agent knows what time it is.

But during **autonomous work** — where the agent keeps going on its own without
you sending messages — those turns don't come from you, so that time-stamp hook
never fires. For minutes or hours the agent gets **no clock at all** and just
carries whatever time it last saw. Worse, even when it *does* get a timestamp,
it's only the absolute time ("it's 5:42") — never "you started 4 hours ago, you
have 8 hours left." To know that, the agent has to remember when it started and
do the math itself every single turn, which it reliably forgets to do.

This isn't hypothetical. In a 12-hour autonomous session, the agent wrote an
"end-of-stretch summary" and wound down after only ~4 hours — convinced the work
was basically over — because it genuinely had no idea only a third of the time
had passed. That's the bug, and the user pointed out it's widespread: agents
across all kinds of long tasks mis-track time and make bad calls because of it.

## What we're changing

Three things, all built so the agent never has to *remember* to check the time —
it's just always there (structure over willpower):

1. **Inject the clock on every kind of turn, not just your messages.** A single
   shared routine prints the current time AND the computed "X elapsed, Y
   remaining of Z (N% done)" for whatever time-boxed work is active. It runs on
   your messages, on autonomous continuations, and on scheduled wake-ups — the
   turns that used to be blind.

2. **A clock the agent can ask.** A new read-only `GET /session/clock` endpoint
   answers "how long have I been running / how much is left," so the agent (or
   you, from the dashboard) can check at any time.

3. **A gentle reality-check.** If the agent starts to say "the session is done"
   while the clock shows lots of time left, a signal nudges it to look at the
   clock first. It never blocks the message — just catches the exact mistake that
   started all this.

## Why it matters

Time-awareness sounds small, but it quietly governs big decisions: when to stop,
when to report, whether a deadline is close. An agent that can't tell time makes
confident, wrong calls about all of those. This makes the clock a permanent,
trustworthy part of every turn — so "how far along are we?" always has a real
answer instead of a guess. It's purely additive: a healthy short chat is
unaffected; the change only shows up when there's a session worth timing.
