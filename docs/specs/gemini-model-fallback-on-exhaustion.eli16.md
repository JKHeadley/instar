# ELI16 — When one Gemini model runs out, switch instead of giving up

## What this is, in plain English

Some instar agents run on Google's Gemini. Gemini offers more than one model —
think of them as two separate engines: a fast one (`gemini-2.5-flash`) and a
heavier one (`gemini-2.5-pro`). Crucially, **each engine has its own separate fuel
tank.** Running the fast engine dry does NOT empty the heavy engine's tank.

## The problem

When the model an agent was using ran out of fuel ("You have exhausted your
capacity on this model, resets in 46 minutes"), instar treated it as "the whole
Gemini account is out of fuel — stop everything." It wrote a little status file
saying `recommendation: stop`, and anything that read that file — including the
agent itself and the mentor watching it — concluded the agent was completely down
for 46 minutes.

But that was wrong: the OTHER engine still had fuel. We saw this live this
session — a Gemini agent's fast model was exhausted, yet the account dashboard
showed plenty of headroom. So we kept reporting "Gemi is blocked" when it wasn't.
(The operator corrected this twice — rightly.)

## What's new

Now, when one model runs out, instar **switches to the other model and keeps
going** — exactly like the equivalent feature we already have for the codex
agents. Only if BOTH models are genuinely out of fuel does it actually stop and
write the "account is blocked" status (now clearly marked as account-wide, so a
reader can tell the difference between "one model resting" and "everything's
out").

The switch is quick (a fraction of a second — no point waiting, since it's a
different fuel tank), and it's loop-proof: each exhausted model is remembered with
its own reset time, so instar never bounces back and forth, and the memory clears
itself once a model's window passes.

## Why it's safe

- It never makes a genuine outage invisible: when every model is exhausted, it
  still defers and still writes the stop status — so doomed retries are still
  prevented, exactly as before.
- The only new cost is, at worst, one extra quick attempt on the second model
  before giving up — and in the common case that second model has fuel, so the
  agent simply keeps working instead of going dark for the better part of an hour.
- It's confined to the Gemini path; Claude and codex agents are untouched.

Proven with 21 tests across three levels (unit, integration, and a live-style
end-to-end run) covering both the "switch and keep going" case and the "everything
is genuinely exhausted, so stop" case.
