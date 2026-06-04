# Per-agent ResourceLedger — plain-English overview

## What this is

Right now an Instar agent keeps good books on some of what it uses, but not all
of it. It tracks **tokens** well (the TokenLedger), and we just made the
**per-system LLM call counts** honest and labeled. But three things it uses every
minute are tracked **nowhere that survives a restart**:

- **CPU** — how much processor it's burning.
- **Memory** — how much RAM it's holding (and whether that's slowly leaking).
- **Rate-limit events** — every time the shared AI account says "too many
  requests, slow down." The agent notices these in the moment and even refuses
  the call to protect itself, but the record evaporates when it restarts. So a
  simple question like "how many times did we get throttled today?" has no
  answer.

This change adds a **ResourceLedger**: a small, durable notebook (a local SQLite
file, exactly like the TokenLedger) where the agent writes down its own CPU,
memory, and every rate-limit event as it happens. Then it exposes a simple
read-only page — `/resources` — so you (or the agent) can look at the numbers.

## The most important safety property

It only **watches and writes things down**. It never blocks a call, never
throttles anything, never changes a decision. It's a measuring tape, not a valve.
That's the same promise the TokenLedger already keeps, and it's why this is
low-risk: the worst a bug here can do is record a wrong number, never break the
agent's actual behavior.

## Why it matters

The shared AI account is overloaded across the whole fleet, and we can't fix that
responsibly until we can **see** where the pressure is coming from. You can't tune
what you can't see. This ledger is the missing eyesight for CPU, memory, and
throttling — the foundation. Actually *acting* on the numbers (shedding load,
moving some work to a different AI provider) is a separate job for later; this
just makes sure we're finally keeping complete books.

## What the reader needs to decide

This is measurement-only and mirrors a pattern already trusted in production
(the TokenLedger). If reviewing: confirm it never gates or changes behavior, and
that it reuses signals the agent already produces (it doesn't add new ways to
detect throttling — it just stops throwing away the ones we already have).
Justin pre-approved the resource-monitoring workstream on topic 18423; this is
its measurement foundation, shipped in small phases (rate-limit store first,
then CPU/memory).
