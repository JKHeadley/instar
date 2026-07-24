---
type: feature
---

## What Changed

The development agent's work queue now reads real active commitments, evolution
actions, feedback clusters, and topic-intent activities through their existing
managers. The registry is wired into the running server so `/work-queue` returns
ranked backlog items instead of an unavailable response; fleet rollout remains
dark behind the development-agent gate.

## What to Tell Your User

On the development agent, unfinished work now appears in one ranked queue backed
by the real local backlog. Fleet agents remain dark until rollout.

## Summary of New Capabilities

- Live adapters for commitments, evolution actions, feedback clusters, and topic intents.
- AgentServer wiring so `GET /work-queue` and rescore serve real ranked items.
- Isolated HTTP proof on port 4056 with copied real state.
