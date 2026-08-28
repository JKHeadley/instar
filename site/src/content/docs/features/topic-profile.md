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

## How you set it — the conversational intent classifier

"Use codex here" is a command; "should we use codex here?" is a question; "codex here keeps
failing" is commentary. A fixed regex cannot tell those apart, so the ingress decision belongs to
**`ProfileIntentClassifier`** — an LLM-with-context recognizer that reads the message plus a bounded
window of recent conversation and infers whether the operator actually asked for a profile change.
The known frameworks, models, and thinking modes are used purely as a guardrail on the *output*
(nothing outside the closed sets can be proposed), never as keyword triggers on the input. Below its
confidence floor, nothing happens — a misread can propose, but only the operator's confirmation
writes.

## Escalation and the pin

A pinned profile is the topic's *baseline*; the heavy-work ultra escalation is a temporary elevation
on top of it, resolved by `ModelTierEscalation` and admitted by `EscalationGovernor`'s cost guards.
The default `escalationOverride: 'inherit'` means a baseline pin does not disable escalation — only
an explicit `'suppress'` opts the topic out. When a topic moves machines mid-escalation, the
`EscalationHintStore` carries the escalation *trigger* (never the tier itself) so the destination
re-decides under its own guards. See [Model-Tier Escalation](../architecture/model-tier-escalation/)
for the full admission model.

## The swap is verified, not assumed

Applying a pin means killing the old session and spawning a new one that reads the pin at launch.
Both steps are held to their real outcomes:

- The kill's result is **read, not assumed**. A kill that does not take aborts the respawn, restores
  the parked resume entry so the surviving session keeps its restart ability, and counts toward the
  circuit breaker as a `kill-failed` attempt — so a session that will not die settles loudly at the
  breaker (park, revert, notify) instead of retrying on every idle window forever.
- The success claim is **truth-checked**. After the spawn, the framework the new session actually
  launched with is compared against the framework the pin resolved to; a divergence is recorded in
  the audit log as `respawn-profile-mismatch`, never as `respawn-applied`. The check is signal-only —
  it blocks nothing — but it makes a switch that silently didn't happen impossible to mistake for one
  that did.

## Safety & rollout

A profile change is a **routing** decision, never a block — it produces a respawn, not a refusal of
your message. Every write requires the topic's verified bound operator (Know Your Principal). The
feature ships **dark** behind a dev-agent gate (dry-run by default); the fleet serves `503` until it
graduates.

See the [Topic Profile API reference](../reference/topic-profile-api/) for the routes and internals.
