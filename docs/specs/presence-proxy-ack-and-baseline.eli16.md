# PresenceProxy — brief-ack tolerance + post-message baseline — Plain-English Overview

> The one-line version: when you message your agent, the "still working on it…" standby updates should be honest, on-topic, and quiet when they'd just be noise — not vanish, not describe the wrong thing, and not pile a redundant echo on top of the agent's own "got it."

## The problem in one breath

When you send your agent a message over Telegram, a background helper ("PresenceProxy") posts gentle "still working…" updates so you're not left wondering if it's alive. Three things went wrong with it over time: (1) the agent's polite "Got it, looking into this" was accidentally switching the whole standby system OFF, so a genuinely stuck agent would go silent forever; (2) when standby updates DID fire, they sometimes summarized what the agent was doing BEFORE your message instead of what it's doing now; and (3) even after the agent already said "got it," the helper would post its own near-duplicate "agent is just starting to respond to <your question restated>" a moment before the real answer — clutter on every single turn.

## What already exists

- **The standby helper (PresenceProxy)** — watches for a user message that hasn't been answered yet and, after a short delay, posts a tiered "still working" update (a first signal of life, then a 2-minute progress note, then a stall check). It's what reassures you during a long wait.
- **The agent's own acknowledgement** — every agent is told to fire a quick "Got it, on it" the instant your message lands, so you know it was received.
- **A shared "is this a real reply or just system chatter?" classifier** — used by several subsystems; not changed here.

## What this adds

The headline: the standby helper now treats a quick acknowledgement correctly in two ways at once — it does NOT let the ack silently kill the safety timers (so a real stall is still caught), AND it no longer posts a redundant standby on top of that ack (so a normal quick task reads cleanly as: ack → answer).

- A small, conservative classifier (`isBriefAck`) recognizes short, forward-looking acks ("On it", "Got it", "Looking into this") without mistaking a real substantive reply for an ack.
- A "baseline snapshot" taken the moment your message arrives, so the standby update describes only what happened AFTER your message — not stale earlier work.
- Post-ack suppression: if the agent already acked, the first-tier standby message is withheld (the ack already covered "I'm alive"), while the later tiers stay armed for genuine silence.

## The new pieces

- **`isBriefAck`** — a signal, not a gatekeeper. It only withholds a cancellation/standby that was about to happen; it never makes the final call on what you see. Biased to be safe: a false "that's an ack" costs at most one missing standby, never a missed stall.
- **Baseline scoping** — narrows the input the summarizer sees to post-message activity; the summarizer still decides the wording.

## The safeguards

**Prevents an agent from going silently dead.** An ack keeps the safety chain armed — if the agent acks and then stalls, the 2-minute and stall-check tiers still fire.

**Prevents wrong-context summaries.** The baseline anchor means updates talk about the current task, falling back to the full view only when the screen has scrolled.

**Prevents per-turn clutter (the new bit).** After an ack, no duplicate "still working" echo — and this works for codex agents too, where the older fix didn't because their screen carries extra stream noise.

## What ships when

One fleet-wide code change to PresenceProxy plus tests; no schema changes, no on-disk artifacts. Every Instar agent benefits on its next update. Rollback is a single-file revert.
