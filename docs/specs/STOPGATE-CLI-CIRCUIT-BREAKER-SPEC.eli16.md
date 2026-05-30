# In plain English: stop a health-check from spamming itself on subscription agents

## What this is about

Instar has a safety feature called the "stop gate." When an AI agent decides to
stop working, the gate quickly asks a small AI model "was that a good reason to
stop, or is the agent giving up too early?" To answer, it runs a quick AI call.

## What went wrong

On agents that run on a Claude subscription (no API key), that quick AI call has
to launch a `claude` command, which takes about five to six seconds just to start
up and answer. But the gate only waits two seconds before giving up. So on those
agents the gate ALWAYS gives up:

- It never actually gets an answer — it just allows the stop every time.
- Worse, it launches a `claude` process and then kills it two seconds later, over
  and over. That wasted work is real CPU churn.
- And every time it gives up, it files a "something is degraded" report. Those
  pile up, so the agent's health page shows "degraded" with dozens of identical
  entries — even though nothing is actually broken. It looks alarming but isn't.

We caught this during a session where every other agent was paused, so there was
no real load — yet the health page still showed "degraded." That's the tell: it
was a code bug, not load.

## What's new

The gate now has a "circuit breaker." After it fails a few times in a row, it
stops trying for a few minutes: it allows the stop instantly without launching any
process, and it stops filing those degraded reports. After the cooldown it tries
once more; if the AI call works, everything goes back to normal automatically.

Crucially, the gate's actual decision doesn't change — it still allows the stop,
exactly as before. The breaker only makes the unavoidable "give up" fast and
quiet instead of slow and noisy.

## What the reader needs to decide

Nothing to configure — it has safe defaults and turns itself on automatically.
Operators who WANT the gate to actually rule on subscription agents can raise the
timeout (a separate setting), accepting that each stop then takes a few seconds
longer. Tests prove the breaker opens after repeated failures, stops launching
processes while open, and heals itself after the cooldown.
