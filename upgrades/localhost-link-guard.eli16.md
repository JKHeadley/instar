# Localhost-Link Guard — Plain-English Overview

> The one-line version: the server now refuses to send a user any message containing a `localhost` link, because the user is almost never sitting on the machine that link points at.

## The problem in one breath

An agent shared its dashboard with the operator by sending `http://localhost:4040/dashboard` over Telegram. The operator was on his phone — a localhost link points at *the phone itself*, so it can never work. Worse, the port was wrong too (it belonged to a different agent on the same machine). The operator called for a strong rule: never send localhost links to a user, ever.

## What already exists

- **The outbound message gate** — every agent-authored message to a user already passes through one checkpoint on the server before it reaches Telegram (or Slack/WhatsApp/iMessage). An LLM reviewer there catches tone problems and technical leakage.
- **The tunnel** — every agent already has a public HTTPS address (the Cloudflare tunnel) that works from any device. That is the link users should always get.
- **Hard deterministic checks** — some rules don't need an LLM's judgment: a message over 4096 characters is rejected flat. This guard joins that family.

## What this adds

A deterministic check at that same chokepoint: if an outgoing user message contains a clickable `http(s)://localhost`, `127.x.x.x`, `0.0.0.0`, or `[::1]` link, the send is rejected with a clear explanation telling the agent to use the public tunnel URL instead (and exactly how to fetch it). The agent gets corrected at the moment of the mistake — no memory or willpower required, and it works fleet-wide the moment a server updates.

- Only **clickable links** are policed. Prose like "my server listens on port 4042" or "the localhost config" passes — the rule is about links a user might tap, not about discussing local machinery.
- Hostnames that merely *start* with localhost (like `localhost.example.com`) are not flagged — the matcher requires a real loopback host.
- A narrow escape hatch exists for the rare case where the operator explicitly asks to see the raw local URL: the sender can mark the message `allowLocalhostLink: true` and it goes through.
- The guard runs even on installs that have no LLM tone gate configured at all — it's independent of that machinery.

## What does NOT change

- Nothing about how tunnel links are generated or shared.
- Agent-to-agent (Threadline) messages are untouched — this is strictly the agent→user path.
- System-template messages (sentinel alerts etc.) were already reviewed at code-review time and keep their existing bypass.

## Why a hard block instead of a warning

A localhost link in a user-bound message has no legitimate reading — the user cannot open it. Warning-and-send would still deliver a broken link; rejecting forces the agent to re-send with the working one. The rejection message itself teaches the fix, so the failure is self-correcting in one round trip.
