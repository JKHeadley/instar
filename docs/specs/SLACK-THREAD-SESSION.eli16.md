# ELI16 — Slack thread→session mapping

## What this is, in one breath

Lets each Slack **thread** be its own ongoing conversation with the agent — a separate, resumable session — instead of every thread in a channel sharing one session. It's the Slack equivalent of how each Telegram topic gets its own session.

## What already existed

For Slack, **one channel = one agent session**. Every message in a channel — including replies in different threads — folded into that single session. (`thread_ts` was captured but never used for routing.) Telegram already did the smarter thing: one topic = one session.

## What's new

A small "routing key" idea: when a reply lands inside a thread (in a channel you've opted in), the agent routes it to a session for *that thread* (`channel:thread_ts`) instead of the shared channel session. So two parallel threads become two parallel conversations the agent keeps straight, and returning to a thread resumes its session.

## The safeguards, in plain terms

- **Off by default.** With no config, the routing key is just the channel id — so it behaves byte-for-byte exactly as today (one channel, one session). You opt specific channels in.
- **No cross-talk.** Two different threads get two different keys, so their messages can never land in the same session; the same thread always gets the same key (resume). A brand-new thread with no replies yet stays on the channel session (no pointless one-off sessions).
- **Slack still gets the right address.** The raw channel + thread id are always recovered from the key, so replies and API calls go to the right place — the key is never mistaken for a channel.
- **Existing reply tooling is unchanged.** The reply script takes an optional thread id (carefully gated so a normal word is never mistaken for one), and a migration refreshes already-installed copies.

## What you actually need to decide

Whether to merge per-thread Slack sessions (off by default; opt-in per channel). It makes the agent able to hold several thread conversations in a channel without mixing them up — the same model that already works for Telegram topics — and changes nothing until you turn it on for a channel.
