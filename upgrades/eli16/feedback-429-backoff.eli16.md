# Feedback retry storm fix — in plain terms

## What this is

Your agent has a little "phone home" feature: when something noteworthy happens, it
saves a feedback note locally and tries to send a copy to a central feedback inbox
over the internet. A background job periodically retries any notes that haven't been
sent yet.

## What was broken

The central inbox started replying "429 — too many requests" (it was rate-limiting
us). The retry job didn't understand "429" as "slow down." It just kept re-sending
the **entire** backlog of unsent notes — 661 of them — every single cycle. Each one
got a 429, none were marked as sent, so the next cycle tried all 661 again. Over time
that piled up to **2,384+ failed sends**, and the repeated bursts of work were one of
the things briefly freezing the agent's main loop (which, knock-on, made the two
machines' clocks look out of sync and broke their handshake — the very problem the
larger project is fixing).

## What's new

The retry now reads the inbox's reply and reacts like a polite client:
- If a note sends fine, it's marked done.
- If the inbox says "429 / try later," the agent **stops the batch immediately**
  (no point hammering a server that's asking us to back off) and **waits** before
  trying again. If the server says exactly how long to wait, it obeys that; otherwise
  it waits a minute, then two, then four… up to an hour, then settles there.
- New notes submitted during a backoff are still saved locally and just wait their
  turn — nothing is lost.

## The safeguards

- **Nothing is dropped.** Every note is still stored locally; backoff only delays
  *sending*, never *recording*.
- **Self-correcting.** The backoff lives in memory; after a restart it tries once and
  re-learns the backoff — no stuck state.
- **Back-compatible.** When the inbox is healthy, behavior is identical to before
  (send immediately, never wait).
- **Reversible.** It's two files; reverting restores the old behavior exactly.

## What you need to decide

Nothing — it's a contained, reversible fix that only makes the agent a better
internet citizen and stops wasted work. The only judgment call baked in: we treat the
two standard "slow down" replies (429 and 503) as stop-signals, and treat other
errors as one-off retries — matching how the wider web expects clients to behave.
