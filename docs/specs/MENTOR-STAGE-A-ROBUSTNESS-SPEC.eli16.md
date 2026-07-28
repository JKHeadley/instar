# In plain English: make the mentor tell us WHY it failed, and stop failing so easily

## What this is about

Instar has a "mentor" that coaches another agent (Codey) through tasks. Each
cycle, the mentor does a step called **Stage-A**: it spins up a tiny throwaway AI
session whose only job is to write the next coaching message (as if it were the
user), then it reads what that session wrote and sends it to the mentee.

On the live agent, Stage-A was **failing every time** — the mentee got nothing —
and worse, we couldn't tell WHY.

## What went wrong

1. **The error was hidden.** When Stage-A failed, the code caught the error and
   threw it away, recording only a useless label: "stage-a-failed." The actual
   reason went to a log line that never showed up where we could read it. So the
   status page just said "stage-a-failed" with zero detail — a dead end for
   debugging.

2. **The setup was fragile.** Stage-A creates that throwaway AI session with no
   safety net. On a busy machine running many agents, creating a new session can
   fail for a moment (too many at once / load). When that happened, Stage-A just
   gave up instantly — no retry, no clear message.

## What's new

1. **Tell us why.** The code now keeps the real error message and puts it on the
   status page (`/mentor/status` → `lastResult.error`). So next time Stage-A
   fails, we see the actual cause — "couldn't create the session: too many open"
   or "timed out" — instead of a blank "stage-a-failed."

2. **Try harder before giving up.** Creating the throwaway session now retries
   once after a short pause (so a momentary hiccup on a busy machine doesn't kill
   the whole cycle). If it still can't, it throws a clear, specific error that —
   thanks to fix #1 — shows up on the status page.

## What the reader needs to decide

Nothing to configure. This doesn't change how the mentor coaches — it just makes
a failing Stage-A both more survivable (a retry) and finally explainable (the
real error is visible). A test proves a failing Stage-A now reports its true
cause instead of the empty "stage-a-failed." If the visible cause later turns out
to be a hard limit (e.g. too many sessions), the next fix becomes obvious from
the message — which is exactly the point.
