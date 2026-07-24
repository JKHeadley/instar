---
type: feature
---

## What Changed

The development agent's work queue now reads real active commitments, evolution
actions, feedback clusters, and topic-intent activities through their existing
managers. The registry is wired into the running server so `/work-queue` returns
ranked backlog items instead of an unavailable response; fleet rollout remains
dark behind the development-agent gate.
