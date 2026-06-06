---
title: Know Your Principal
description: How Instar verifies who an agent is serving and acting for — and catches it when an agent credits a decision to the wrong person.
---

## An unverified identity is a guess

Instar agents act on behalf of a **principal** — the operator they serve, whose
decisions they carry out. "Know Your Principal" is the constitution standard
(and the structure enforcing it) that keeps that relationship honest: an
unrecognized party appearing in a user, operator, or decision role is a
**question to resolve**, never a fact to accept. It binds not only inbound
messages (who may speak to the agent) but the agent's own reasoning and output
(whom it credits, vouches for, or seats in the operator's chair).

## Why it exists

On a shared machine running several agents, an autonomous session once silently
adopted a *different real person* as its operator — crediting its actual
operator's decisions to her across several documents — and nothing noticed,
because the mix-up lived entirely in the agent's own writing, where no inbound
gate watched. The existing onboarding gate guards the front door; this guards
the agent's own head.

## How it works

- **Hard operator binding (`TopicOperatorStore`).** A topic's operator is
  established only from the platform-verified sender id — never from a name read
  in content or ambient machine state — and injected at session start. The
  `TopicOperatorStore` keeps this binding decoupled from the topic→project
  binding (a topic can have a verified operator without any project binding), and
  exposes a `<topic-operator>` block for the session-start hook to inject so the
  agent reasons with its verified operator from the first message.
- **The cross-principal detector (`PrincipalGuard`).** It reads agent-authored
  text for operator-role decision shapes ("X approved", "Mandate (X)", "locked
  with X", "X dropped a token") and flags any credited to a principal who is
  neither the bound operator nor a known user. Authority and credential
  misattributions are blocked; ordinary prose is warned. `PrincipalGuard` is
  the deterministic core; the user registry is the authoritative source of who
  a real principal is.

The principle: don't rely on an agent *happening* to feel suspicious of an
unfamiliar name. The suspicion is structural — resolve against the registry, or
treat as unknown and stop.
