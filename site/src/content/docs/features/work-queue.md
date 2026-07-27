---
title: Work Intake & Prioritization Queue
description: One ranked registry over every known piece of unfinished Instar work — commitments, evolution actions, feedback clusters, and topic-derived tasks — scored deterministically so dispatch comes from the top, not from memory.
---

Unfinished work used to live in four separate places — the commitments store, the evolution
action queue, the feedback pipeline, and per-topic conversation intent — and "what should the
agent work on next?" meant checking all four by hand. The work queue normalizes them into one
deterministic ranked list.

## What it does

Each source item becomes a normalized WorkItem with a deterministic score built from its
explicit priority, whether the operator directed it, its urgency, its age (capped so ancient
items can't dominate), and its goal alignment. Duplicates across sources collapse by title and
kind, keeping the higher-scored copy. The `WorkQueue` registry (implemented by the
`WorkQueueRegistry` class in `core/WorkQueue`) holds the ranked result and rescoring is a pure
recomputation — no stored state to drift.

## Reading the queue

- `GET /work-queue` — the current ranked list.
- `POST /work-queue/rescore` — recompute the ranking from live sources (a pure-compute
  trigger; it performs no durable writes).

Both routes are development-agent gated: on installs where the gate resolves dark they answer
503 rather than serving an empty or stale list.

## Maturation status

Version 1 ships the normalized shape, deterministic ranking, duplicate collapsing, and the
gated read/rescore routes. The source adapters that feed real backlog items and the server
wiring that constructs the registry land as the follow-up increment — until then the routes
answer honestly that the queue is unavailable rather than pretending an empty ranking is a
real one.
