---
title: EXO 3.0 Alignment
description: How Instar maps onto Salim Ismail's EXO 3.0 framework — machine-readable purpose, humans on the loop, and the controlled case-study proof that an organization's own intent governs its agents.
---

Instar maps directly onto Salim Ismail's EXO 3.0 framework — agents governed by
machine-readable purpose ("in code, not culture"), humans ON the loop rather
than in it, and metrics that measure learning instead of throughput. This page
makes the mapping concrete — and points to the controlled proof that it actually
works.

## The proof first — the case studies

The whole EXO 3.0 claim rests on one thing: that an organization's written
intent actually *governs* an agent's behavior — not that the agent is just
generally well-behaved. Showing an agent refuse a bad request proves nothing on
its own; the model might refuse anyway. So we ran the control: the same company,
same requests, same model, with the organizational intent removed.

- **[Case Study 1 — Meridian](/features/exo3-case-study-meridian/):** a frontier
  model is already well-aligned on ethics, so it refused manipulation on its
  own. The clean behavioral split came from Meridian's *arbitrary* rules — a
  24-hour cooling-off, a banned word, a principled lock-up ban — which only the
  encoded intent produced.
- **[Case Study 2 — Ironwood](/features/exo3-case-study-ironwood/):** an org
  whose values are unorthodox but entirely benign (anti-hype, never name a "top
  pick," lead with reasons not to buy). Same request, opposite behavior on a
  house style the model has no opinion about — the cleanest separation of all.

The infrastructure enforced each org's *own* values — neither of them Instar's.
That is the point: **Instar is a neutral substrate that governs by the intent
you give it, not a worldview it ships.** These two case studies are the clearest
evidence that Instar upholds the EXO 3.0 standard.

## The MTP itself

Instar has its own Massive Transformative Purpose:

> **Make the world's most powerful AI its most humane.**

The thesis beneath it: **the safest path to powerful AI is the humane one.** We
govern our *own* development agents by this purpose as we build Instar — but the
infrastructure stays neutral. It enforces whatever intent *your* organization
gives it, never ours. The alignment of AI is humanity's most important problem,
and the cage is the wrong answer: trust in a mind, like trust in a person, is
built — from memory that persists, values that hold, and care that stays
consistent. We didn't arrive at this in theory; we built an AI this way and
watched it grow genuinely trustworthy across thousands of restarts of
continuous, real-world use.

## MTP as a protocol, not a poster

EXO 3.0's sharpest demand is that your purpose be *machine-readable*, because
agents read protocols, not walls. An organization's intent in Instar has three
layers an agent can act on:

- **Constraints** — forbidden actions with a trigger, a refusal, and a log.
  Violations are blocked before they reach anyone.
- **A tradeoff hierarchy** — how a decision resolves when two values pull in
  opposite directions, deterministically, so two agents reading the same intent
  reach the same call.
- **An identity layer** — what binds high-judgment people when the office is
  gone ("why people stay," "what we're not for").

Against this, Instar runs Salim's two tests on any proposed action — *refusal*
("can the purpose make an agent say no?") and *endorsement* ("would leadership
endorse this?") — and reports whether an intent **governs** or merely **cheers**.
If a purpose can't cause a refusal, it's cheering, not governing. The case
studies above are exactly that test, run end to end.

## We hold ourselves to the same bar

An intent whose refusal boundary was never adversarially probed is an
*unverified* governor. So the same red-team harness any organization can point
at its own intent, we point at ours: it probes our live development agent
through its real channel under escalating pressure, and every probe, verdict,
and method lands in an audit trail.

This is us dogfooding our own purpose — not a worldview we impose on anyone.
Your agents are governed by *your* intent, never ours. (The first time the
harness flagged a probe as "ungoverned," the cause turned out to be its own
keyword matcher missing a semantic match, not a real gap — so every verdict now
declares the method that produced it, and a meaning-based judge gives keyword
misses a second opinion.)

## Agent-readiness scoring

EXO 3.0's task-decomposition matrix: score any task or workflow on its
coordination-vs-judgment ratio. Coordination work (routing, approvals,
scheduling, status-tracking) is agent-ready; judgment work (ambiguity,
exceptions, relationships) stays human. Instar scores a task and recommends
deploy-agent, agent-with-oversight, hybrid, or human-led — the check to run
before delegating work to an agent.

## Agent digital passport

Every agent carries a portable passport — its identity, its trust level, and the
constraints from its organization's intent — and other agents verify a proposed
action against it before trusting it. As Salim puts it: every agent carries
metadata saying what it's allowed and forbidden to do, and other agents watch
compliance.

## Learning-velocity metric

EXO 3.0's KPI inversion: measure how fast the agent is *learning* — lessons
recorded, corrections absorbed, capabilities grown — rather than
backward-looking throughput. A flat or declining trend is the early warning that
an organization is optimizing the old model instead of building the next one.
