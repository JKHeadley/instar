# Slack live-test cleanups — Plain-English Overview

> The one-line version: make the agent's wrongful SILENCES in Slack countable (so we can measure them during the live test), and fix a spec that described a "considered" mode the code never actually had.

## The problem in one breath

When the agent sits quietly in a Slack channel and decides NOT to speak, that decision left no trace anywhere — only the times it DID speak got logged. So if the agent was staying silent when it should have piped up (or vice versa), there was no way to count how often that happened during the careful observe-only trial. Separately, the Slack design doc claimed there was a third "response mode" called `considered` that the shipped code never had — the real behavior is built a different way.

## What already exists

- **The ambient "should I speak?" gate** — in channels explicitly opted in, an undirected message (one nobody addressed to the agent) gets a conservative check that almost always says "stay silent." It only ever makes the agent quieter. This is off by default everywhere.
- **A speak-path log** — when the gate decides to speak, that gets written to the console and to an observability hook. Silences were invisible.
- **The `/permissions/decisions` route** — a durable, file-backed ledger for the OTHER (authority) Slack gate, used to measure its decisions before enforcing.

## What this adds

The ambient gate now keeps a small running tally, per channel, of every time it was consulted: how many it evaluated, how many it spoke on, how many it stayed silent on, and — the useful bit — how many silences were "near-misses" (it almost spoke, its confidence landed just below the bar). It also keeps a short, capped list of the most-recent near-miss silences so a person can eyeball them. A new read-only web route, `GET /permissions/ambient-stats`, hands that tally to whoever is running the live test.

The doc fix simply rewrites the design spec so it matches reality: there is no `considered` response mode value; "considered/ambient mode" is the `mention-only` mode plus a per-channel opt-in list.

## The new pieces

- **The ambient stats aggregate** — an in-memory counter living on the gate itself. It is NOT allowed to change any speak/silence decision; it only watches and counts after the decision is already made. That line matters: an observability bug must never make the agent louder or quieter.
- **`GET /permissions/ambient-stats`** — a read-only window into that counter. It sends no Telegram messages and creates no forum topics, so it can't cause notification spam. It reports "not present" when no channel has opted in (the normal case).

## The safeguards

**Prevents the agent from getting louder or quieter by accident.** The counting happens after the verdict is fixed, is wrapped so a counting bug is swallowed, and a regression test asserts the verdict is byte-for-byte identical whether or not the counter runs.

**Prevents notification floods.** The new surface is a passive counter and a read-only route — it never creates a Telegram topic or message. The flood burst-invariant test still passes.

**Prevents unbounded memory growth.** The near-miss list is a fixed-size ring (default 50); the per-channel map is bounded by the small, config-controlled set of opted-in channels. A test floods it with 100 near-misses and confirms the ring stays capped.

## What ships when

Both cleanups ship together in one Tier-1 commit: the observability code + its tests, and the doc-accuracy edit. Nothing is staged behind a flag because the ambient gate itself is already dark by default — with no opted-in channel, nothing is recorded and the route reports "not present."

## What you actually need to decide

Are you OK merging a signal-only observability addition (no behavior change, fully dark by default) plus a doc-accuracy fix to the Slack spec — yes or no?
