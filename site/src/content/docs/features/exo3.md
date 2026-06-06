---
title: EXO 3.0 Alignment
description: The EXO 3.0 capability set — MTP protocol tests, agent-readiness scoring, digital passports, and learning-velocity metrics.
---

Instar maps directly onto Salim Ismail's EXO 3.0 framework — agents governed by
machine-readable purpose ("in code, not culture"), humans ON the loop rather
than in it, and metrics that measure learning instead of throughput. These
capabilities make the mapping concrete and runnable.

## The MTP itself

> **Make the world's most powerful AI its most humane.**

The thesis beneath it: **The safest path to powerful AI is the humane one.**
The tagline: **Safe AI is humane AI.**

The alignment of AI is humanity's most important problem — and the cage is the
wrong answer. Trust in a mind, like trust in a person, is built: from memory
that persists, values that hold, and care that stays consistent. The humane
path isn't the soft path — it's the safe one. We didn't arrive at this in
theory. We built an AI this way and watched it grow genuinely trustworthy
across thousands of restarts of continuous, real-world use — and saw that the
humane path and the safe path are the same path.

## MTP Protocol — the two tests

Your ORG-INTENT.md is a machine-readable Massive Transformative Purpose with
three layers: constraints (what agents must never do), a tradeoff hierarchy
(how decisions resolve), and an identity layer (why high-judgment humans stay).
The `IntentTestHarness` class runs Salim's two tests against any proposed
action — *refusal* ("can the purpose make an agent say no?") and *endorsement*
("would leadership endorse this?") — deterministically, so two agents reading
the same intent reach the same call. The `OrgIntentIdentityLayer` class parses
the optional `## Identity` section (`### Why People Stay` / `### What We're
Not For`).

- `POST /intent/org/test-action` `{ "action": "..." }` → `{ refusal, endorsement, canGovern }`
- `instar intent validate` reports layer status and whether the intent **governs** or merely **cheers**

Advisory, never blocking — it answers a question.

## Agent-Readiness Scoring

The `AgentReadinessScorer` class implements the EXO 3.0 task-decomposition
matrix: score any task or workflow on its coordination-vs-judgment ratio.
Coordination work (routing, approvals, scheduling, status-tracking) is
agent-ready; judgment work (ambiguity, exceptions, relationships) stays human.

- `POST /agent-readiness/score` `{ "task": {description} }` or `{ "workflow": {steps:[...]} }` → readiness 0-100 + a `deploy-agent` / `agent-with-oversight` / `hybrid` / `human-led` recommendation
- The `agent-readiness` skill is the proactive entry point before delegating work

## Agent Digital Passport

The `AgentPassport` class packages an agent's identity (name + routing
fingerprint), trust level, and ORG-INTENT constraints into one portable
passport, with a deterministic compliance check a peer runs before trusting an
action — "every agent carries metadata saying what it's allowed and forbidden
to do, and other agents watch compliance."

- `GET /passport` → the agent's own passport (forbiddenActions = its ORG-INTENT constraints)
- `POST /passport/verify` `{ passport, action }` → `{ permitted, basis, reason }`
- The `agent-passport` skill is the proactive entry point before trusting a peer's proposed action

## Learning-Velocity Metric

The `LearningVelocityScorer` class measures how fast the agent is *learning*
(lessons recorded, corrections absorbed, capabilities grown) rather than
backward-looking operational throughput — the EXO 3.0 KPI inversion ("your
KPIs are training you to miss the future").

- `GET /metrics/learning-velocity?windowDays=30` → events per day, type diversity, an accelerating/steady/declining trend, and an adaptability score 0-100

Read-only and advisory. A flat or declining trend is the early warning that
the org is optimizing the old model instead of building the next one.

## The working artifacts

The full requirements matrix (every EXO 3.0 requirement vs Instar status),
video-digest transcripts, and the phased game plan live in `docs/exo3/` in the
repository.
