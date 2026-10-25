---
title: Model-Tier Escalation
description: How a session gets a bigger model for heavy work — tier resolution, admission control, and how an escalation survives a cross-machine move.
---

Model-tier escalation runs a session on the ultra model for the heavy-work triggers (spec design,
long builds, autonomous runs) and on the default tier the rest of the time. Three components divide
the problem so that no single piece holds both the *what* and the *whether*: a resolver that maps
tiers to concrete model ids, a governor that decides admission, and a hint store that lets an
escalation follow a topic across machines without ever becoming a free grant.

## `ModelTierEscalation` — the (framework, tier) → model-id resolver

The resolver owns the closed per-framework model-id enumerations and per-adapter swap-capability
declarations. Its contracts are all fail-closed:

- It reads **only trusted config** (`models.tierEscalation`) — a mode-state file can request a
  *tier*, but it can never supply a model *id*. That boundary is what keeps an untrusted state file
  from steering a launch argument.
- Every id is validated by regex **and** membership in the framework's closed `knownModelIds`
  enumeration before it can reach a launch arg or a tmux keystroke — the keystroke-injection guard.
- An absent or `null` escalated entry resolves to the default, which means **no swap ever** — the
  backwards-compat posture for frameworks (codex, gemini, pi) that have no ultra model configured.
- The worst-case failure of every path is `null`: the session stays on its default model. Escalation
  is a routing decision; it can never block a message, a tool call, or a session.

## `EscalationGovernor` — admission control (the cost guards)

The governor decides whether an escalation may happen *right now*, and every refusal means "the
session stays on its default model" — never a blocked session. Concurrency onto one account is not a
bare headroom read but a **lease**: a reservation keyed on the spawn-generated session-instance id,
bounded by `maxConcurrentEscalatedPerAccount`, carrying a TTL, released when the session is reaped,
and reclaimable when its holder is no longer live (expiry is evaluated lazily on read — no dedicated
poller). Quota headroom, the hourly budget, and dwell hysteresis sit in front of every admit.

## `EscalationHintStore` — escalation rides the topic, as a trigger, never a grant

Escalation leases are keyed on the session-instance id, and a cross-machine topic transfer respawns
the session with a *new* instance id — so the live escalation would silently drop mid-heavy-work.
The hint store is the ephemeral carrier that closes this gap: the source machine records the topic's
active escalation **trigger**, and the destination re-admits through its **own** `EscalationGovernor`
cost guards. The load-bearing safety invariant: a hint decides whether to *ask*, never the answer. If
the destination's guards refuse (cap reached, no quota headroom) or the topic is pinned
`escalationOverride: 'suppress'`, the session runs the default tier — the move degrades safely
rather than smuggling a tier grant across machines.

## How it meets Topic Profile

A topic's pinned profile is the *baseline*; escalation is a temporary elevation on top of it. A
baseline pin does not disable heavy-work escalation (`escalationOverride: 'inherit'` is the
default) — only an explicit `'suppress'` opts the topic out. When the topic-profile orchestrator
profile-kills a session, it clears the topic's escalation marker and releases its lease before the
respawn, so a stale lease can never survive a profile change.
