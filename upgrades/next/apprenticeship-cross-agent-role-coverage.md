---
title: Apprenticeship role coverage now sees peer-agent cycles
audience: agents
---

## What Changed

`GET /apprenticeship/instances/:id/role-coverage` now combines the serving agent's cycle rows with bounded authenticated reads from running, registered non-lifeline agents on the same host. Exact cycle UUIDs are deduplicated before the existing keystone calculation runs. The response adds `aggregation.complete`, `omittedPeerCount`, `conflictingCycleIds`, and `peerSources` so failed, capped, truncated, or contradictory peer reads remain explicit.

## Evidence

Unit coverage proves bounded peer discovery, authenticated fetches, explicit partial results, and deduplication. Integration coverage proves a remote keystone changes a formerly false-starved route result. The AgentServer E2E proves the merged result and source metadata are live through the production route. TypeScript and the affected apprenticeship suites pass.

## What to Tell Your User

Apprenticeship role health now reflects cycles recorded by other agents on the same machine, instead of treating this agent's local database as the whole program. If a peer cannot be read, the answer says the census is incomplete rather than quietly claiming the keystone is starved.

## Summary of New Capabilities

The existing role-coverage endpoint provides a same-host cross-agent merged view with per-source completeness metadata. It remains read-only and never gates apprenticeship lifecycle actions.
