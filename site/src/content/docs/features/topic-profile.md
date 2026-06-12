---
title: Topic Profile
description: Sticky per-topic framework / model / thinking-mode pins, applied with the gentlest session swap and honest loss disclosure.
---

Every conversation topic carries three "execution settings": which **agent framework** runs it
(Claude Code vs Codex), which **model** it uses (an explicit id or a tier), and how hard the model
**thinks** (`off` / `low` / `medium` / `high` / `max`). Topic Profile unifies those three into one
durable, sticky profile you set per topic — it survives restarts and follows the topic.

## What it does

You set a topic's profile conversationally — "use codex here", "pin this topic to Fable", "set high
thinking on this topic" — and the agent proposes the change back in plain words, confirms, and the
pin is durable from then on. The `/topic` command and the `/topic-profile` HTTP route exist for the
dashboard and power users, but the agent never tells you to type a command.

When a pin changes and the running session can't simply adopt it, the change is applied by the
**gentlest swap path**, and the agent tells you honestly whether anything was lost:

- **In-flight model-tier swap** — a within-framework Claude model-tier change on a confirmed-idle
  session swaps live, with **zero** loss.
- **Restart via `claude --resume`** — none-loss: the conversation is preserved, the session just
  relaunches under the new profile.
- **Continuation** — when no resume point can be captured, the topic continues from recent history
  plus memory (recent-only).

Protected, busy, and autonomous sessions are **never** profile-killed. A busy session applies the
switch the moment it goes idle — or immediately if you say "switch now" (which overrides busy, but
never overrides protection). If a pinned profile repeatedly fails to launch, a circuit breaker parks
the pin, reverts to the last-known-good profile, and tells you.

## How it fits together

- **`TopicProfileStore`** holds each topic's pinned profile as durable data (a single-writer
  compare-and-set store, so a config write can never silently clobber an operator's setting).
- **`TopicProfileResolver`** resolves the effective profile for a topic at session-spawn time.
- **`TopicProfileOrchestrator`** is the engine that applies a changed pin — it classifies the change,
  picks the gentlest swap, respects protection/busy/autonomous, and runs the circuit breaker.
- **`CodexResumeMap`** captures Codex's resume handle so a Codex topic can also restart none-loss.
- **`TopicProfileTransferCarrier`** carries a topic's profile across machines: when another machine
  acquires the topic, it pulls the profile so the pin follows you everywhere.

## Safety & rollout

A profile change is a **routing** decision, never a block — it produces a respawn, not a refusal of
your message. Every write requires the topic's verified bound operator (Know Your Principal). The
feature ships **dark** behind a dev-agent gate (dry-run by default); the fleet serves `503` until it
graduates.

See the [Topic Profile API reference](../reference/topic-profile-api/) for the routes and internals.
