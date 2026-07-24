---
title: "Unified work intake and prioritization registry"
---

## What Changed

Added a normalized, deterministic work queue with dev-gated read and rescore routes. The queue is advisory and currently uses a typed adapter contract for commitments, evolution actions, feedback clusters, and topic-derived work.

## What to Tell Your User

On the development agent, unfinished work can be viewed in one ranked queue instead of checking several separate lists. Fleet rollout remains dark while the source adapters are completed.

## Summary of New Capabilities

- Normalized WorkItem shape and deterministic ranking.
- Cross-source duplicate suppression.
- GET /work-queue and POST /work-queue/rescore.

## Evidence

WorkQueue unit tests pass; routes are dark unless the dev-agent feature gate resolves live.
