---
title: PR-Lease API & PrHandLease
description: The GET /pr-leases read surface, the POST /pr-leases/evaluate decision route, and the PrHandLease store that backs the parallel-hand PR lease.
---

The parallel-hand PR lease is backed by the `PrHandLease` store (`src/core/PrHandLease.ts`)
and two HTTP routes. All routes require the standard `Authorization: Bearer <token>`.

## GET /pr-leases

Registry-First read: returns every per-branch lease record with its **derived
liveness** (`live` / `stale-dead` / `stale-ttl` / `tombstoned` / `foreign-machine`),
computed honestly from timestamps + the in-memory running set. The liveness-probe
handle (`holderSessionId`) is redacted from the response. Returns `503` when the
feature is not enabled on this agent.

## POST /pr-leases/evaluate

Called by the PreToolUse guard hook before a `git push`. Body: `{ command, cwd,
topicId, sessionName }`. The server derives the canonical branch key, runs
`PrHandLease.evaluate`, and returns `{ decision: 'allow' | 'deny' | 'escalate',
reason, holder? }`. Fail-open: a disabled feature, a malformed request, an
underivable branch key, or any internal error all return `decision: 'allow'`. Under
the default `dryRun:true` a would-deny is rewritten to `{ decision: 'allow', wouldDeny:
true }` — the soak observes decisions without blocking any push.

## The PrHandLease store

`PrHandLease` exposes:

- `evaluate(key, myTopicId, mySessionId)` — the push-chokepoint decision (allow / deny / escalate), never throws.
- `acquireOrRenew(key, holder)` — acquire or renew my lease for a branch (atomic CAS under the process lock).
- `takeOverIfStale(key, observed, holder)` — atomic compare-and-swap takeover of a stale lease; the loser yields.
- `release(key, topicId, status)` — release my lease with a terminal tombstone status.
- `list()` — the read view (records + derived liveness) backing `GET /pr-leases`.
- `canonicalPushKey(command, cwd)` — the exported pure helper that derives `branch:<ref>` from a `git push` command via git's own ref resolution.

Identity is the stable `holderTopicId` (survives session respawn); `holderSessionId`
is a liveness-probe handle only. `holderMachineId` is load-bearing for the rule that a
foreign-machine holder is never judged dead from local session absence.
