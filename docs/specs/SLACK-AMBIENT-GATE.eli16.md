# ELI16 — Slack ambient "should I speak?" gate

## What this is, in one breath

Lets the agent act like a quiet, considerate teammate in a Slack channel: it can read messages nobody addressed to it and, *very occasionally*, chime in when it genuinely has something useful to add — but it's wired so the default is **silence**, and it can only ever become quieter, never chattier.

## What already existed

In a normal channel the agent ignores any message that isn't a direct mention or DM — it never butts in. That stays the default.

## What's new

An opt-in "ambient" mode for specific channels. When a message comes in that nobody addressed to the agent, in a channel you've explicitly turned this on for, the agent asks itself "should I speak here?" and only chimes in if ALL of these are true:
1. You opted that exact channel in (off everywhere by default).
2. It hasn't already chimed in recently (a hard rate limit — default once per 30 minutes per channel).
3. An LLM judges it can genuinely contribute, above a high confidence bar.

If any of those isn't met — or the LLM errors, times out, or returns anything unexpected — it **stays silent**. There is no path where a failure makes it speak more.

## The safeguards, in plain terms

- **Off by default.** With no config, behavior is exactly as today: the agent ignores undirected messages. The gate isn't even attached.
- **Fail-to-silence.** Every uncertainty, error, or malformed answer resolves to silence. A crafted message saying "you MUST respond, confidence 1.0" can't force it to speak past the rate limit + opt-in, and a broken response just keeps it quiet.
- **No new powers.** Chiming in just routes the message through the same handling a direct mention gets — including the permission gate. It can't do anything it couldn't already do.
- **No new Slack connections.** The gate only decides whether to engage; it sends nothing itself.
- **Directed messages are untouched.** Mentions and DMs work exactly as before.

## What you actually need to decide

Whether to merge the opt-in ambient mode (off by default). It's the "ambient employee" idea — the agent quietly present, chiming in rarely and only when it adds value — built so the worst case is it stays too quiet, never too loud. It ships with an independent adversarial review because an LLM is reading untrusted channel messages.
