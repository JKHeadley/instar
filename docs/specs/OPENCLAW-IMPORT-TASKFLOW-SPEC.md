---
review-convergence: 2026-05-07T19:55:00Z
approved: true
---

# Instar TaskFlow — Managed Multi-Step Job Primitive (Imported from OpenClaw)

> Durable, optimistic-concurrency multi-step job records with typed wait reasons, owned by a controller. Replaces ad-hoc state-shuffling in the bug-cluster pipeline with a single auditable lifecycle.

**Status**: Review-Convergence
**Converged**: 2026-05-07T19:55:00Z
**Author**: Echo (parallel OpenClaw audit, 2026-05-07)
**Date**: 2026-05-08
**Origin**: §8 #1 of `.claude/research/openclaw-audit-instar-2026-05-07.md` (Echo project). OpenClaw source (verified at commit `f482e4d335`): `src/tasks/task-flow-registry.ts:376-586` (createManagedTaskFlow surface), `src/tasks/task-flow-registry.types.ts:14-43` (record + status types), `src/tasks/task-flow-registry.store.sqlite.ts:361-371` (`withWriteTransaction`, BEGIN IMMEDIATE), `src/plugins/runtime/runtime-taskflow.ts:14-220` (consumer pattern reference — wraps create/wait/resume/finish for runtime plugins), `src/tasks/task-flow-runtime-internal.ts:1-18` (internal helpers). Audited at OpenClaw commit `f482e4d335`.
**Related**: SharedStateLedger v2 (Integrated-Being), CommitmentSweeper, EvolutionManager (PROP queue), InitiativeTracker, JobScheduler

---

## Table of Contents

1. [TL;DR](#tldr)
2. [The Problem](#the-problem)
3. [The OpenClaw Primitive](#the-openclaw-primitive)
4. [Design Principles](#design-principles)
5. [Architecture](#architecture)
6. [Record Shape](#record-shape)
7. [Lifecycle](#lifecycle)
8. [Storage and Concurrency](#storage-and-concurrency)
9. [Integration with Existing Instar Subsystems](#integration-with-existing-instar-subsystems)
10. [Migration Plan](#migration-plan)
11. [Risks and Mitigations](#risks-and-mitigations)
12. [Threat Model](#threat-model)
13. [Open Questions](#open-questions)
14. [Non-Goals](#non-goals)
15. [References](#references)

---

## TL;DR

A `TaskFlow` is a SQLite-backed durable record `{flowId, controllerId, revision, status, goal, currentStep, stateJson, waitJson, ...}` with optimistic-concurrency mutations. Controllers create managed flows, run them step-by-step, set them to wait on typed reasons (`reply | human-review | external-call | scheduled-tick | cross-agent-callback`), and resume them when the wait condition fires. Status transitions are gated by `expectedRevision` so two concurrent writers cannot silently overwrite each other.

For Instar, TaskFlow replaces three ad-hoc state-shuffling paths:
- The **bug-cluster pipeline** (cluster → tier-1-fix-attempt → ratification → tier-2-expansion) currently lives across `EvolutionManager`, `DispatchExecutor`, and `HandoffManager` as plain JSON files with no concurrency primitive.
- The **initiative tracker** has phases and blockers but no controller / no typed waits / no revision contract.
- **Cross-agent collaboration over Threadline** has no continuation primitive — when Echo asks Dawn a question, the "I'm waiting on her reply" state lives in the Telegram thread, not in any registry.

Importing TaskFlow gives all three a common managed-flow shape with one durable record per flow, an explicit controller, typed waits, and revision-conflict detection.

## The Problem

Today, when Echo runs a bug-cluster fix attempt:

1. The cluster is identified by `EvolutionManager` and written to `proposals.jsonl`.
2. Tier-1 fix attempt is dispatched via `DispatchExecutor`; outcome lands in `dispatch-decisions.jsonl`.
3. Ratification by Justin happens over Telegram with no durable pointer back to the cluster.
4. Tier-2 expansion (when the tier-1 fix fails) re-reads the JSONL files and reconstructs state from the most recent matching entries.

Failure modes today:
- **Lost continuation**: if Echo's session dies between dispatch and ratification, the next session has to scan multiple JSONL files to figure out "what was Echo waiting on?"
- **No concurrency primitive**: two sessions could each pick up "the same" cluster and dispatch competing fixes. Today this is prevented by the single-process assumption, not by structure.
- **Implicit waits**: "waiting for Justin" is a state that lives in Echo's head, not in any registry. The CommitmentSweeper can sweep stranded commitments but has no equivalent for stranded work-in-progress.
- **Cross-agent waits are fictive**: if Echo sends Dawn a question and waits for her reply, there is no registry entry that says "Echo flow X is waiting on Dawn reply Y." The wait exists only in the conversation transcript.

A managed-flow record solves all four by making the wait first-class, durable, and revision-gated.

## The OpenClaw Primitive

Source: `src/tasks/task-flow-registry.ts:376-586`, `src/tasks/task-flow-registry.types.ts:14-43`.

```typescript
type TaskFlowSyncMode = "task_mirrored" | "managed";

type TaskFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;        // who advances this flow
  revision: number;             // optimistic concurrency
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;        // controller-private state
  waitJson?: JsonValue;         // typed wait reason
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
```

Key API surface:

```typescript
createManagedTaskFlow({...fields, controllerId})
updateFlowRecordByIdExpectedRevision({flowId, expectedRevision, patch})
  // returns {applied: true, flow} or {applied: false, reason: "revision_conflict", current}
setFlowWaiting({flowId, expectedRevision, waitJson, currentStep, ...})
resumeFlow({flowId, expectedRevision, status, currentStep, ...})
finishFlow({flowId, expectedRevision, ...})
failFlow({flowId, expectedRevision, blockedSummary, ...})
requestFlowCancel({flowId, expectedRevision, cancelRequestedAt})
```

Storage: SQLite with `BEGIN IMMEDIATE` write transactions (`task-flow-registry.store.sqlite.ts:361-371`). In-memory `flows` Map cache for read speed.

Consumer pattern (from `extensions/active-memory/index.ts:2891-2998`): a controller calls `createManagedTaskFlow` to start, updates `currentStep` and persists private state into `stateJson` as it advances, calls `setFlowWaiting({waitJson:{kind:"reply"|"human-review"|"external-call"}})` when blocking on something, then `resumeFlow` when the wait fires, then `finishFlow` or `failFlow` at the end.

## Design Principles

1. **Controller-owned, not consensus-owned**. A flow has exactly one controller (`controllerId`). The controller is the only entity allowed to advance state. No "either Echo or Dawn can resume this flow." If a controller dies, the flow goes `lost`; recovery is a separate maintenance pass.
2. **Optimistic concurrency by default**. Every mutation requires `expectedRevision`. Conflicts are detected, not silently merged. This is the single-process safety net AND the multi-process correctness guarantee.
3. **Typed waits, not free-form**. `waitJson.kind` is an enum: `reply | human-review | external-call | scheduled-tick | cross-agent-callback`. Each kind has known fields and a known resolution path.
4. **State is private to the controller**. `stateJson` is opaque to the registry. The registry exposes `goal`, `currentStep`, `status`, `waitJson`; everything else is the controller's business.
5. **No automatic resumption**. The registry does not poll waits; controllers register listeners (e.g., the messaging-arrival handler resumes flows waiting on `kind:"reply"`). This keeps the registry pure storage.
6. **Sweeper-as-reserved-controller**. A maintenance sweeper detects flows that look `lost | stranded` and writes a status transition through the normal OCC API using a reserved `controllerId: "TaskFlowMaintenance"` that the registry whitelists for terminal-from-running and terminal-from-waiting transitions. The sweeper additionally emits a SharedStateLedger note for audit. (Earlier drafts proposed pure signal-shape; per Round 1 review, that produced an "is this flow terminal?" question with two answers — the flow row and a separate ledger note. Reserved-controller writer keeps the registry the single answer for status while the ledger note carries the rationale.)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      TaskFlowRegistry (server)                      │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  SQLite store (.instar/task-flows.db, WAL, single writer)   │   │
│   │  - one row per flow                                         │   │
│   │  - revision++ on every patch                                │   │
│   │  - BEGIN IMMEDIATE wraps read+write check-and-discriminate  │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              ▲                                      │
│   ┌──────────────────────────┴──────────────────────────────────┐   │
│   │  In-process LRU cache (Map<flowId, TaskFlowRecord>)         │   │
│   │  - one cache, one writer (the server) — coherent by design  │   │
│   │  - cache update AFTER successful COMMIT                     │   │
│   │  - cache invalidate on COMMIT failure                       │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              ▲                                      │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
        ┌──────────────────────┼─────────────────────┐
        │                      │                     │
   Controller A           Controller B       TaskFlowMaintenanceSweeper
   (EvolutionManager,     (InitiativeTracker, (reserved controllerId; markLost
    in-process)            in-process)         via OCC; emits ledger audit note)
        │                      │                     │
        ▼                      ▼                     ▼
   createFlow             resumeFlow            markLost(expectedRevision,
   setFlowWaiting         finishFlow                     ledgerEntryId, reason)
   pingFlow              (with expectedRevision         + SharedStateLedger note
   (heartbeat)            and waitInstanceId)
```

Wait-arrival paths feed back into controllers. Every wait-arrival path resolves to a *durable* `(flowId, expectedRevision, waitInstanceId)` triple by querying the registry — no in-memory state is required to survive a restart.

**System-waker carve-out**: `TaskFlowDueWaker`, `ThreadlineFlowBridge`, `MessageRouter`'s reply-wait path, and the `external-call` callback endpoint are not the owning controller for the flows they wake. They run **in-process inside the server**, holding a direct reference to the `TaskFlowRegistry` instance — so they can call registry methods directly (not through HTTP). Direct calls still go through the same authorization layer as HTTP; the registry's `resumeFlow` method takes a `principal` argument that the in-process holder sets to the `system-waker` principal it was constructed with.

The registry exposes a small **wait-lookup API** for these system-wakers, callable both in-process and over HTTP (with `system-waker` or `admin` scope). All return shape: `Array<{flowId, revision, waitInstanceId, controllerId, waitJson}>`:

```typescript
registry.findWaitingByReply({channel, threadId, peer}): WaitMatch[]
registry.findWaitingByCorrelation({waitKind, correlationId}): WaitMatch[]
registry.findWaitingByDueAt({nowMs}): WaitMatch[]   // returns scheduled-tick rows where dueAt <= nowMs
```

Each method is a single SQL query against the indexed columns above. The HTTP form is `GET /flows/waiting?...` with query parameters mirroring these methods; the response carries the same shape but with `stateJson` and full `waitJson` redacted (only the fields the waker needs for routing).

A system-waker resolves a callback by:
1. Calling the appropriate `findWaiting*` method to get `WaitMatch[]`.
2. Performing the wait-kind-specific identity check (e.g., signature verification for `cross-agent-callback`).
3. Calling `resumeFlow(flowId, expectedRevision, waitInstanceId)` with the matched values.
4. Emitting `EventBus.emit('taskflow:wait-fired', {flowId, controllerId})` so the owning controller can pick up the now-`running` flow and advance its step.

This separates "the wait is satisfied" (system-waker authority, transitions waiting → running) from "the controller owns the next step" (controller authority, all subsequent transitions). The owning controller's wait-fired handler reads the flow via `getFlow(flowId)` and advances; the controller never holds long-lived state about pending waits in memory.

Note: HTTP clients (sessions outside the server) MAY also use these endpoints when authenticated as `admin` for debugging or admin tooling, but the production wait-resolution path runs in-process for latency and to keep `system-waker` principals out of the externally-issued token set.

- `kind:"reply"` — `MessageRouter` on inbound message looks up `flows WHERE status='waiting' AND wait_json.kind='reply' AND wait_json.channel=? AND wait_json.threadId=? AND wait_json.peer=?`; resumes via system-waker scope. **Uniqueness contract**: at most one active `reply` wait may exist per `(controllerId, channel, threadId, peer)`; `setFlowWaiting` rejects with `wait_collision` if a duplicate is detected.
- `kind:"human-review"` — explicit `/ratify <flowId>` slash command resolves to the flow and resumes via system-waker scope; the Telegram-attention-queue entry carries `flowId` so the ratify/reject affordance calls `resumeFlow` directly.
- `kind:"external-call"` — completion-callback URL `POST /flows/:id/resume-via-callback` accepts a webhook with `correlationId`; the registry verifies the correlationId matches the active `waitJson` and resumes via system-waker scope.
- `kind:"scheduled-tick"` — `TaskFlowDueWaker` queries `flows WHERE status='waiting' AND wait_json.kind='scheduled-tick' AND wait_json.dueAt <= now` every minute and resumes each via system-waker scope.
- `kind:"cross-agent-callback"` — `ThreadlineFlowBridge` on inbound (signature-verified) Threadline message looks up `flows WHERE status='waiting' AND wait_json.kind='cross-agent-callback' AND wait_json.threadId=? AND wait_json.correlationId=?`; verifies `wait_json.expectedAgentId == verifiedSenderAgentId`; resumes via system-waker scope.

The `waitInstanceId` is read from the flow row at callback-handling time, not held in memory between `setFlowWaiting` and the eventual callback. This makes wait resolution restart-safe.

## Record Shape

Trimmed port of the OpenClaw shape. v1 drops fields whose semantics are not needed in Instar (`syncMode`, `blockedTaskId`, `blockedSummary`, status `blocked`) and adds Instar-specific fields:

```typescript
export interface TaskFlowRecord {
  flowId: string;                    // ulid
  ownerKey: string;                  // domain-specific group key, e.g. "cluster:<clusterId>"
                                     // or "initiative:<id>"; max 256 chars
  requesterOrigin?: RequesterOrigin; // see RequesterOrigin below; replaces OpenClaw DeliveryContext
  controllerId: string;              // e.g. "EvolutionManager" | "InitiativeTracker" |
                                     // "ThreadlineFlowBridge" | "TaskFlowMaintenance" (reserved)
  controllerInstanceId: string;      // uuid set on controller startup. Carried in the body of every
                                     // controller-scope mutation (startStep, setFlowWaiting, resumeFlow,
                                     // finishFlow, failFlow, cancelFlow, pingFlow); the registry overwrites
                                     // the stored value on each successful mutation. Used by pingFlow as the
                                     // OCC-exempt identity check, and by markLost audit notes. After server
                                     // restart, the new instance re-attaches by calling GET /flows?controllerId=X
                                     // (to enumerate live flows) then issuing pingFlow with the new instanceId
                                     // (which overwrites the stale value). The first ping after restart
                                     // succeeds because pingFlow checks `flow.controllerId == auth.controllerId
                                     // && status='running'` only — it does NOT compare instanceId on entry; it
                                     // SETS the new instanceId. (Correction to earlier draft text: pingFlow's
                                     // "instanceId equality" check applies only to subsequent pings within the
                                     // same instance lifetime; the first ping from a new instance re-binds.)
  controllerHeartbeatAt: number;     // unix-millis-utc; bumped on every mutation by this controller
  revision: number;                  // bumped on every patch
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;    // see Notification Policy below
  goal: string;                      // short human-readable; max 1024 chars
  currentStep?: string;              // max 128 chars; e.g. "tier-1-fix-attempt"
  stateJson?: JsonValue;             // controller-private state; max 64 KiB serialized
  waitJson?: WaitJson;               // typed wait; max 8 KiB serialized
  waitInstanceId?: string;           // uuid; set when status=waiting; required arg to resume
  waitStartedAt?: number;            // unix-millis-utc; set on every successful setFlowWaiting; cleared on resume
  cancelRequestedAt?: number;        // unix-millis-utc
  cancelRequestedBy?: RequesterOrigin; // who requested cancel; set with cancelRequestedAt
  createdAt: number;                 // unix-millis-utc; server-assigned
  updatedAt: number;                 // unix-millis-utc; server-assigned on every mutation
  endedAt?: number;                  // unix-millis-utc; set on transition to terminal status
  supersededBy?: SupersededRef;      // pointer to ledger note that explains a sweeper-driven
                                     // transition; null on normal terminal transitions
  privacyScope?: PrivacyScopeType;   // matches MemoryEntity scope vocabulary
}

export type SupersededRef = {
  kind: 'ledger-note';
  ledgerEntryId: string;
  reason: 'lost' | 'stranded' | 'manual-supersede';
};

export type RequesterOrigin = {
  kind: 'user' | 'agent' | 'system' | 'job';
  id: string;
  channel?: string;                  // e.g. "telegram:9000", "threadline:<threadId>"
};

export type WaitJson =
  | { kind: 'reply'; channel: string; threadId: string; peer: string; }
  | { kind: 'human-review'; question: string; topicId?: number; reviewerId?: string; }
  | { kind: 'external-call'; serviceId: string; correlationId: string; deadline?: number; }       // unix-millis-utc
  | { kind: 'scheduled-tick'; dueAt: number; jobSlug?: string; }                                  // unix-millis-utc;
                                                                                                  // jobSlug is currently unused by TaskFlowDueWaker (which polls by dueAt);
                                                                                                  // reserved for future JobScheduler one-shot integration where the slug
                                                                                                  // identifies a scheduler entry.
  | { kind: 'cross-agent-callback'; threadId: string; correlationId: string; expectedAgentId: string; };
```

**Time fields**: every timestamp in the record is `unix-millis-utc` (int64). String timestamps in incoming requests (e.g., RFC3339) are normalized on write.

**Status taxonomy** (trimmed from OpenClaw): `queued | running | waiting | succeeded | failed | cancelled | lost`. Removed `blocked` — it overlapped `waiting`. Invariant: `status='waiting'` iff `waitJson != null && waitInstanceId != null`. Invariant: terminal statuses (`succeeded | failed | cancelled | lost`) imply `endedAt != null` and any further mutation attempt MUST fail with `already_terminal`.

**`notifyPolicy`** (Instar-defined; OpenClaw's exact semantics are not adopted):

```typescript
export type TaskNotifyPolicy =
  | { kind: 'silent' }                                         // default; no notifications
  | { kind: 'on-wait'; topicId: number }                       // notify on entering waiting status
  | { kind: 'on-terminal'; topicId: number }                   // notify on succeeded|failed|cancelled|lost
  | { kind: 'on-wait-and-terminal'; topicId: number };
```

**Field-size validation**: writes that exceed declared maxima fail with `invalid_argument`. The registry validates `waitJson` against the `WaitJson` discriminated union (zod schema) on every write.

**Notification dispatch**: on a successful mutation, after COMMIT and before cache update, the registry inspects `notifyPolicy`:
- `kind:'silent'` (default): no-op.
- `kind:'on-wait'` and the mutation transitioned to `waiting`: emit a Telegram message to `topicId` via `TelegramAdapter` with shape `{flowId, goal, currentStep, waitJson.kind, waitJson.question? (for human-review only), revision}`.
- `kind:'on-terminal'` and the mutation transitioned to a terminal status: emit `{flowId, goal, status, currentStep, supersededBy?, revision}`.
- `kind:'on-wait-and-terminal'`: union of the two.

Notification is best-effort and emitted asynchronously (fire-and-forget after COMMIT). Phase 1 ships the wiring with notifications stubbed at metric-emission only (`taskflow_notify_emitted_total`). Phase 5 wires through the actual `TelegramAdapter` send.

## Lifecycle

```
                      createManagedTaskFlow
                                │
                                ▼
                          status: queued
                                │
                       (controller picks up)
                                │
                                ▼
                         status: running
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       setFlowWaiting        finishFlow        failFlow
       (kind: ...)         (status: succeeded) (status: failed)
              │
              ▼
       status: waiting
              │
       (wait fires; controller observer
        calls resumeFlow with expectedRevision)
              │
              ▼
       status: running   (loop)
```

`requestFlowCancel` is orthogonal — sets `cancelRequestedAt` on any non-terminal flow. Controllers check `cancelRequestedAt` between steps and call **`cancelFlow`** (the dedicated terminal-transition operation) when honoring it. (Earlier draft text referred to "failFlow with status: cancelled"; that was wrong — `failFlow` produces `status='failed'`. Use `cancelFlow` for `status='cancelled'`.) Cancellation is advisory: controllers MUST honor on the next step boundary; the registry will not force-terminate.

Any principal with `controller` (matching controllerId), `admin`, or any externally-issued bearer-token scope may request cancel. The registry persists the requester identity in two ways: (1) `cancelRequestedBy: RequesterOrigin` is set on the flow row alongside `cancelRequestedAt`; (2) a SharedStateLedger note `kind:'taskflow-cancel-requested'` is emitted carrying `flowId, revision, cancelRequestedBy`. Schema below adds the column.

**Cancel-while-waiting wakeup**: `requestFlowCancel` on a flow whose `status='waiting'` MUST also emit `EventBus.emit('taskflow:cancel-requested', {flowId, controllerId})`. The owning controller's cancel-requested handler is responsible for: (a) calling the same wait-lookup APIs to release any in-flight wait state; (b) calling `cancelFlow(flowId, expectedRevision)` to finalize the terminal transition. Without this wakeup, a `waiting` flow with a 30-day human-review threshold would sit in `waiting` until the natural wait fires. Controllers register the cancel-requested handler at startup alongside the wait-fired handler.

`status: lost` is set ONLY by the `TaskFlowMaintenance` reserved controller, never by a normal controller.

## Mutation Semantics

Every mutation goes through one of these typed operations. Each operation requires `expectedRevision` and bumps `revision` by 1 on success.

### Legal status transitions

```
            createFlow (POST /flows)
                  │
                  ▼
              queued ──cancelFlow──▶ cancelled
                  │
              startStep
                  │
                  ▼
              running ──setFlowWaiting──▶ waiting
                  │                          │
                  │                          │ resumeFlow
                  │                          │
                  │ ◀────────────────────────┘
                  │
                  ├─ finishFlow ─▶ succeeded
                  ├─ failFlow ───▶ failed
                  ├─ cancelFlow ─▶ cancelled  (only when cancelRequestedAt is set)
                  └─ markLost ───▶ lost       (TaskFlowMaintenance only; from running OR waiting)
```

`waiting → cancelled`, `waiting → failed`, and `waiting → lost` are also legal (the wait does not need to fire first). Terminal statuses (`succeeded | failed | cancelled | lost`) accept no further mutations: any attempt fails with `already_terminal`.

### Per-operation contract

| Operation | Required pre-state | Required args | Post-state | Server bumps |
|---|---|---|---|---|
| `createFlow` | (none — flow does not exist) | `idempotencyKey` (uuid; unique per `(controllerId, ownerKey, idempotencyKey)`) | `queued` | revision=1, createdAt, updatedAt |
| `startStep` | `queued` or `running` | `controllerInstanceId`, `currentStep` | `running` | revision++, updatedAt, controllerHeartbeatAt, controllerInstanceId rebound |
| `setFlowWaiting` | `running` | `controllerInstanceId`, `waitJson` (validated against WaitJson) | `waiting` | revision++, updatedAt, controllerHeartbeatAt, controllerInstanceId rebound, waitInstanceId (server-generated uuid), waitStartedAt=now, wait_kind denormalized |
| `resumeFlow` | `waiting` | `waitInstanceId` (must match record); `controllerInstanceId` (controller scope) OR system-waker scope; optional `currentStep`; optional `statePatch` | `running` | revision++, updatedAt, controllerHeartbeatAt, waitInstanceId cleared, wait_kind cleared, waitStartedAt cleared |
| `finishFlow` | `running` | `controllerInstanceId`, `result` (optional, stored in stateJson under `_result`) | `succeeded` | revision++, updatedAt, endedAt |
| `failFlow` | `running` or `waiting` | `controllerInstanceId`, `failureReason` | `failed` | revision++, updatedAt, endedAt |
| `requestFlowCancel` | non-terminal | `requesterOrigin` | unchanged status | cancelRequestedAt=now, cancelRequestedBy=requesterOrigin, revision++, updatedAt; if status=waiting, EventBus emits `taskflow:cancel-requested` |
| `cancelFlow` | non-terminal AND `cancelRequestedAt != null` | `controllerInstanceId` | `cancelled` | revision++, updatedAt, endedAt |
| `markLost` | `running` or `waiting`; reserved controller `TaskFlowMaintenance` only | `ledgerEntryId`, `reason: 'lost' \| 'stranded'` | `lost` | revision++, updatedAt, endedAt, supersededBy |
| `pingFlow` | `running` | `controllerInstanceId` | unchanged | revision UNCHANGED; updatedAt + controllerHeartbeatAt updated. NOT keyed on `expectedRevision` — see Heartbeat contract below |
| `getFlow` | (any) | optional `bypassCache: true` | (read-only) | — |

### Conflict result shape

OCC failures return a structured response that distinguishes from not-found:

```jsonc
// 409 Conflict
{
  "error": "revision_conflict",
  "current": { ...current TaskFlowRecord... }
}
// 404 Not Found
{ "error": "not_found", "flowId": "..." }
// 410 Gone (terminal)
{
  "error": "already_terminal",
  "current": { ...record with terminal status... }
}
// 422 Unprocessable
{ "error": "invalid_transition", "from": "succeeded", "op": "setFlowWaiting" }
{ "error": "invalid_argument", "field": "goal", "reason": "exceeds 1024 chars" }
{ "error": "unauthorized_controller", "expected": "EvolutionManager", "actual": "InitiativeTracker" }
{ "error": "already_consumed", "waitInstanceId": "..." }   // resume request supplied a waitInstanceId but the
                                                            // flow is already running and waitInstanceId is null
                                                            // (i.e., the wait already fired). If the supplied
                                                            // waitInstanceId is wrong (never matched), the response
                                                            // is "invalid_argument" instead.
```

Implementation: when `UPDATE flows SET ... WHERE flow_id=? AND revision=?` returns 0 rows, the storage layer follows up with `SELECT revision, status, ended_at FROM flows WHERE flow_id=?` to discriminate `not_found` from `revision_conflict` from `already_terminal`. This SELECT runs in the same connection inside the same `BEGIN IMMEDIATE` to keep the read consistent with the write attempt.

### Idempotency

- `createFlow` requires an `idempotencyKey`. The unique index is `(controllerId, ownerKey, idempotencyKey)`. Duplicate creates return the existing record with HTTP 200 (not 201) — this is the safe-retry behavior for clients that timed out mid-create.
- `resumeFlow` requires `waitInstanceId`. The server records the consumed `waitInstanceId` atomically with the resume; a duplicate callback (same waitInstanceId) returns `already_consumed`.

### Heartbeat contract

A controller actively running a step MUST call `pingFlow(flowId, controllerInstanceId)` at least once per `HEARTBEAT_INTERVAL_MS` (default: 60s).

`pingFlow` is **NOT keyed on `expectedRevision`** — this is intentional, and makes pingFlow the single OCC-exempt operation. The reason: every other writer (sweeper, peer controllers, the controller's own step advancement) bumps revision; if pingFlow also took expectedRevision, the controller would routinely conflict with its own concurrent operations and never successfully heartbeat. Instead, pingFlow's correctness key is `(flow.controllerId == caller.controllerId, flow.status == 'running')`. Mismatch fails with `unauthorized_controller` or `invalid_transition`. `controllerInstanceId` is REBOUND on every successful ping — the registry overwrites the stored value with the supplied one. This makes ping the natural re-attach mechanism after a server restart: the first ping with the new instanceId succeeds and updates the row. Older instanceIds are not preserved; that's intended (the prior instance is gone, and the audit ledger note for any sweeper-driven `markLost` will have captured the old instanceId before this point if it mattered). ping does not transition status; it cannot break invariants.

`pingFlow` updates `controllerHeartbeatAt` and `updatedAt`, leaves `revision` and all other fields untouched. Concurrent ping + step-advance on the same revision are both safe: the step-advance bumps revision via the OCC path; the ping merely refreshes heartbeat without touching the revision.

The maintenance sweeper's lost-eligibility rule depends on `status` and (for `waiting`) on `waitJson.kind`; see the next subsection.

### Sweeper threshold policy (normative)

The `TaskFlowMaintenanceSweeper` runs hourly and evaluates lost-eligibility per row using these rules:

| Status | Rule | Default |
|---|---|---|
| `running` | `now - controllerHeartbeatAt > RUNNING_LOST_THRESHOLD_MS` | 6 hours |
| `waiting`, `wait_kind = 'reply'` | `now - waitStartedAt > REPLY_LOST_THRESHOLD_MS` | 7 days |
| `waiting`, `wait_kind = 'human-review'` | `now - waitStartedAt > HUMAN_REVIEW_LOST_THRESHOLD_MS` | 30 days |
| `waiting`, `wait_kind = 'external-call'` | if `waitJson.deadline` set: `now > deadline + EXTERNAL_GRACE_MS`; else `now - waitStartedAt > EXTERNAL_LOST_THRESHOLD_MS` | grace 1h, fallback 7 days |
| `waiting`, `wait_kind = 'scheduled-tick'` | NEVER lost-eligible. `TaskFlowDueWaker` resolves these. | — |
| `waiting`, `wait_kind = 'cross-agent-callback'` | `now - waitStartedAt > XAGENT_LOST_THRESHOLD_MS` | 7 days |

`waitStartedAt` is a column on the `flows` table set on every successful `setFlowWaiting` (resets on every fresh wait, NOT preserved across resume → re-wait cycles). Indexed jointly with `status` to bound sweeper scan cost.

All thresholds are configurable via `.instar/config.json` under `taskFlow.thresholds`. Defaults are the values above.

### Storage failure handling

- `SQLITE_BUSY`: retry with exponential backoff up to `MAX_BUSY_RETRIES` (default: 5; base 50ms, cap 5s). After exhaustion, return HTTP 503 with `Retry-After` header.
- `SQLITE_FULL`: return HTTP 507; alert via DegradationReporter.
- I/O error mid-commit: surface as HTTP 500; the cache MUST NOT be updated for the failed mutation. Cache-update ordering: cache write happens AFTER the SQLite COMMIT returns successfully. If COMMIT throws, the cache entry is *invalidated* (deleted) so the next read forces a reload.

## Storage and Concurrency

### Single writer, one process (v1)

In v1, **the instar server process is the only writer** to `.instar/task-flows.db`. All controllers — EvolutionManager, InitiativeTracker, ThreadlineFlowBridge, TaskFlowMaintenance — run inside the server process or inside server-spawned Claude Code sessions. Sessions interact with the registry exclusively through the HTTP API (`POST /flows`, etc.), not by opening the SQLite file directly.

This makes the in-memory cache safe: there is one cache, one writer, and OCC handles in-process concurrency between the server's own controllers. HTTP clients (sessions) get cache-coherent reads because their reads hit the same server's cache.

**Future multi-writer**: if Instar later needs another process to write (e.g., the lifeline supervisor mutating flows during a server restart), this section will need a leader-election or per-row lease layer. Out of scope for v1; tracked under Open Questions.

### Storage layout

- One SQLite file: `.instar/task-flows.db`, WAL journal mode, `busy_timeout 30000ms`, `synchronous=NORMAL` (with WAL, this is durable to OS crash but not power loss; matches the rest of Instar's SQLite stores).
- Schema:

  ```sql
  CREATE TABLE IF NOT EXISTS flows (
    flow_id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    controller_id TEXT NOT NULL,
    controller_instance_id TEXT NOT NULL,
    controller_heartbeat_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    notify_policy TEXT NOT NULL,        -- json
    goal TEXT NOT NULL,
    current_step TEXT,
    state_json TEXT,
    wait_json TEXT,
    wait_instance_id TEXT,
    wait_started_at INTEGER,
    wait_kind TEXT,                     -- denormalized from wait_json; set on setFlowWaiting; null otherwise
    cancel_requested_at INTEGER,
    cancel_requested_by TEXT,           -- json RequesterOrigin
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    superseded_by TEXT,                 -- json {kind, ledgerEntryId, reason}
    privacy_scope TEXT,
    requester_origin TEXT               -- json
  );
  CREATE INDEX flows_status_updated_at  ON flows (status, updated_at);
  CREATE INDEX flows_controller_status  ON flows (controller_id, status);
  CREATE INDEX flows_owner_key          ON flows (owner_key);
  CREATE INDEX flows_wait_instance_id   ON flows (wait_instance_id) WHERE wait_instance_id IS NOT NULL;
  CREATE INDEX flows_wait_kind_started  ON flows (wait_kind, wait_started_at) WHERE status='waiting';
  CREATE INDEX flows_running_heartbeat  ON flows (controller_heartbeat_at) WHERE status='running';

  CREATE TABLE IF NOT EXISTS flow_create_idem (
    controller_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    PRIMARY KEY (controller_id, owner_key, idempotency_key)
  );
  ```

- Write transactions use `BEGIN IMMEDIATE` because each mutation reads (to discriminate not-found / conflict / terminal) AND writes within the same transaction. (Per Round 1 review, a single `UPDATE` would not strictly need `BEGIN IMMEDIATE`; the transaction wraps the read+write check-and-discriminate sequence.)

### DR and audit trail (no dual-write)

**JSONL append log dropped from v1.** Round 1 review converged on the dual-write hazard: SQLite-then-JSONL or JSONL-then-SQLite both have non-atomic recovery paths. SQLite WAL is itself a durable, crash-safe journal — an extra app-level append log adds risk without adding recovery power.

For DR we instead rely on:

1. **SQLite WAL** as the durability journal. `synchronous=NORMAL` plus WAL gives durable writes that survive process crash.
2. **Backup System** (existing Instar capability): `.instar/task-flows.db` is included in the snapshot rotation, providing point-in-time recovery from periodic backups.
3. **Audit ledger**: every status transition that crosses a workflow boundary (start, wait, resume, terminal) emits a `SharedStateLedger` `note` with `kind: 'taskflow-transition'`, capturing `flowId`, `revision`, `from_status`, `to_status`, `currentStep`, `waitJson.kind` (NOT full waitJson — see privacy below), `controllerId`. The ledger note is best-effort: if the ledger write fails, the registry mutation has already committed, so we lose audit but not state. This is the right asymmetry — state correctness is tier-1, audit is tier-2.

### In-memory cache

- LRU `Map<flowId, TaskFlowRecord>`, capped at `MAX_CACHE_ENTRIES` (default: 1000). Eviction prefers entries with `endedAt != null` (terminal flows are unlikely to be re-read).
- Cache populated on read-miss and on every successful mutation.
- On COMMIT failure, cache entry is invalidated.
- `getFlow(flowId, {bypassCache: true})` forces a SQLite read.

### Privacy / sync exposure

`.instar/task-flows.db` and any JSONL audit fragments **MUST be on the git-sync deny-list** (`.instar/.gitignore` augmented in Phase 1). `stateJson` may contain user PII (cluster fix payloads, ratification questions, raw LLM prompts). Cross-machine sync of TaskFlow state is not in v1 scope; if added later, it must be an opt-in encrypted channel separate from git.

`stateJson` is also redacted from:
- audit ledger notes (only `flowId`, `revision`, `currentStep` go into notes; never `stateJson` content);
- any HTTP API response that is not addressed to the owning `controllerId`. The `GET /flows/:id` endpoint returns full record only when `Authorization: Bearer <token>` is presented and the caller's controllerId matches; otherwise returns the redacted shape (no `stateJson`, no `waitJson`'s identifying fields).

## Integration with Existing Instar Subsystems

1. **EvolutionManager (bug-cluster pipeline)** — primary consumer.
   - Today, what the spec calls "the bug-cluster pipeline" is informal — there is no single subsystem that owns it; it spans `EvolutionManager` (proposals, learnings, gaps, actions), ad-hoc dispatch logic, and Telegram/handoff notes. TaskFlow makes that pipeline a first-class object instead of an emergent behavior.
   - `controllerId: "EvolutionManager"`
   - Per-cluster `ownerKey: "cluster:<clusterId>"`
   - Steps: `tier-1-investigation → tier-1-fix-dispatch → waiting-ratification → tier-2-investigation → tier-2-fix-dispatch → waiting-ratification → completed`
   - Each `waiting-ratification` is `setFlowWaiting({kind:"human-review", question:"...", topicId:9000+ratification})`.
   - The dispatch decision and outcome live in `stateJson`; the flow's `currentStep` is the canonical "where are we" pointer.

2. **InitiativeTracker** — replace the existing phase/blocker model with a TaskFlow per initiative.
   - `controllerId: "InitiativeTracker"`
   - `ownerKey: "initiative:<id>"`
   - Phase transitions become `currentStep` updates.
   - Blockers become `setFlowWaiting({kind:"...", ...})` with the blocker described in `waitJson`.

3. **Threadline cross-agent flows** — new consumer (`ThreadlineFlowBridge`).
   - There is no `ThreadlineGateway` class in Instar today; the closest existing components are `ThreadlineRouter` (`src/threadline/ThreadlineRouter.ts`, decides spawn vs resume on inbound messages) and `MessageRouter` (`src/messaging/MessageRouter.ts`, the underlying inbound pipeline).
   - Phase 2 introduces a new module `src/tasks/ThreadlineFlowBridge.ts` that hooks into `MessageRouter`'s receive pipeline alongside `ThreadlineRouter`. It owns one job: when an inbound Threadline message arrives, look up flows whose `waitJson.kind == 'cross-agent-callback'` matches `(threadId, correlationId)`, verify the message's signed sender identity (via `MessageSecurity` envelope) equals `expectedAgentId`, then call `resumeFlow`.
   - `controllerId: "ThreadlineFlowBridge"` for these flows.
   - `ownerKey: "thread:<threadId>"`.
   - When Echo asks Dawn a question and needs to wait for her reply: `setFlowWaiting({kind:"cross-agent-callback", threadId, correlationId, expectedAgentId:"dawn"})`. The `correlationId` MUST be ≥128 random bits and is single-use.
   - **Identity verification (security-critical)**: `expectedAgentId` matching uses Threadline's signed-message identity (the verified `from` recovered from the message's signature in `MessageSecurity`), NOT the claimed `from:` field of the message. Any inbound message that fails signature verification is rejected before the bridge even sees it.

4. **CommitmentSweeper** — adjacent, not merged.
   - Commitments stay in SharedStateLedger. TaskFlow handles open work-in-progress.
   - `CommitmentSweeper` is a signal-shaped sweeper (per `docs/signal-vs-authority.md` and Integrated-Being v2 spec). `TaskFlowMaintenanceSweeper` is *not* signal-shaped; it is a writer with a reserved controllerId. The asymmetry is intentional: commitments are utterances people made and we observe over time; flows are state machines that need a single durable answer for "what status is this flow now?".

5. **JobScheduler** — provides one-shot wakeups for `scheduled-tick` waits.
   - JobScheduler in Instar is currently cron-only (`JobDefinition.schedule: string` → croner expression; `src/scheduler/JobScheduler.ts`). It does not natively support one-shot at-time-T jobs.
   - **Phase 2 must extend JobScheduler with one-shot support** OR Phase 1 must include a small `TaskFlowDueWaker` sweeper that polls `flows WHERE status='waiting' AND wait_json.kind='scheduled-tick' AND wait_json.dueAt <= now` every minute and fires `resumeFlow`.
   - Recommendation: ship `TaskFlowDueWaker` in Phase 1 (simpler, fully self-contained), revisit JobScheduler one-shot support as a separate enhancement.
   - Either way, the existing JobScheduler `SkipLedger` is not used for these wakeups; idempotency is enforced via `waitInstanceId` on the resume call.

6. **MessageSentinel** — does NOT see flows.
   - Sentinel works on inbound messages, before any flow logic. It can issue `kill-session` which terminates the *session* but does not advance any flow.
   - Sessions terminated by sentinel will stop sending pings to their flows. After `LOST_THRESHOLD_MS` of no heartbeat, `TaskFlowMaintenanceSweeper` marks those flows `lost`. This is the intended path: sentinel kills the misbehaving session, sweeper cleans up its abandoned flows.

7. **Lifeline `ServerSupervisor`** — does NOT write to TaskFlow in v1.
   - The supervisor restarts the server when it dies. It does not interact with the flow registry directly. After a restart, controllers running in the new server process MUST start a new `controllerInstanceId` and re-attach to flows by `controllerId`; flows whose previous `controllerInstanceId` is gone are detectable via heartbeat staleness.

## HTTP API surface

All endpoints loopback-only by default (`127.0.0.1:4042`); `Authorization: Bearer <auth-token>` required on every call. The API MUST NOT be exposed via Cloudflare tunnel without an explicit per-deployment opt-in (default: tunnel routes for `/flows/*` are blocked at the tunnel-config layer).

### Auth model (token → principal binding)

The server maintains a **caller registry** that maps each registered token to a principal record:

```typescript
type FlowPrincipal = {
  tokenId: string;                  // hashed token id (never raw token)
  scope: 'controller' | 'admin' | 'maintenance' | 'system-waker';
  controllerIds?: string[];         // for scope='controller', the controllerIds this principal may act as
};
```

The default Instar auth token (the one in `.instar/config.json`) is bound at server-startup time to a single principal with `scope: 'admin'` — it can act as any controllerId. Additional tokens (created via a not-yet-existing admin command) may be bound to specific controllerIds for least-privilege use. **The caller-asserted `controllerId` in a request body is NEVER the authorization basis**; it is matched against the principal's `controllerIds` (or accepted unconditionally for `admin` scope) and rejected on mismatch with `unauthorized_controller`.

Scope authority matrix:

| Scope | createFlow | startStep | setFlowWaiting | resumeFlow | finishFlow | failFlow | requestFlowCancel | cancelFlow | markLost | pingFlow | getFlow (full) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `controller` | ✓ (own controllerIds) | ✓ (own) | ✓ (own) | ✓ (own) | ✓ (own) | ✓ (own) | ✓ (any flow — cancellation is advisory and cross-controller hygiene is allowed) | ✓ (own) | ✗ | ✓ (own) | ✓ (own) |
| `admin` | ✓ (any) | ✓ (any) | ✓ (any) | ✓ (any) | ✓ (any) | ✓ (any) | ✓ (any) | ✓ (any) | ✗ | ✓ (any) | ✓ (any) |
| `maintenance` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ (any) |
| `system-waker` | ✗ | ✗ | ✗ | ✓ (waiting → running only, with valid waitInstanceId) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (any, but stateJson redacted) |

Special principals (no externally-issued tokens):
- `maintenance`: held in-process by `TaskFlowMaintenanceSweeper`; only invokes `markLost`.
- `system-waker`: held in-process by `TaskFlowDueWaker`, `ThreadlineFlowBridge`, `MessageRouter` reply-wait path, and the `external-call` callback handler. Only allowed transition: `waiting → running` via `resumeFlow` with matching `waitInstanceId` and (per wait kind) identity verification.

For v1, expect exactly one externally-issued bearer token (admin scope), two in-process special principals, and any future per-controller tokens added by hand. The auth model is intentionally minimal; multi-tenant fine-grained auth is out of v1 scope.

| Method | Path | Purpose | Body | Response |
|---|---|---|---|---|
| POST | `/flows` | createFlow | `{controllerId, controllerInstanceId, ownerKey, goal, idempotencyKey, notifyPolicy?, requesterOrigin?, privacyScope?, stateJson?, currentStep?}` | 201 + record on new; 200 + record on idempotent dupe |
| GET | `/flows/:id` | getFlow | (query: `bypassCache=1`) | 200 + record OR redacted shape if caller controllerId mismatches |
| POST | `/flows/:id/start` | startStep | `{expectedRevision, controllerInstanceId, currentStep}` | 200 + record (stored instanceId overwritten) |
| POST | `/flows/:id/wait` | setFlowWaiting | `{expectedRevision, controllerInstanceId, waitJson, currentStep?}` | 200 + record (waitInstanceId in record; stored instanceId overwritten) |
| POST | `/flows/:id/resume` | resumeFlow | `{expectedRevision, waitInstanceId, controllerInstanceId?, currentStep?, statePatch?}` | 200 + record (`controllerInstanceId` optional for system-waker resumes; required for controller-scope resumes) |
| POST | `/flows/:id/ping` | pingFlow (heartbeat) | `{controllerInstanceId}` | 200 + `{updatedAt, controllerHeartbeatAt}` (revision unchanged; stored `controllerInstanceId` overwritten with body value); 422 `unauthorized_controller` if caller's controllerId mismatches flow's; 422 `invalid_transition` if status != running |
| POST | `/flows/:id/finish` | finishFlow | `{expectedRevision, controllerInstanceId, result?}` | 200 + record |
| POST | `/flows/:id/fail` | failFlow | `{expectedRevision, controllerInstanceId, failureReason}` | 200 + record |
| POST | `/flows/:id/cancel-request` | requestFlowCancel | `{requesterOrigin}` | 200 + record (cancelRequestedBy persisted; EventBus emits `taskflow:cancel-requested` if status=waiting) |
| POST | `/flows/:id/cancel` | cancelFlow | `{expectedRevision, controllerInstanceId}` | 200 + record |
| POST | `/flows/:id/lost` | markLost (TaskFlowMaintenance only) | `{expectedRevision, ledgerEntryId, reason}` | 200 + record |
| GET | `/flows` | list (sweeper / admin) | (query: `controllerId?`, `status?`, `updatedBefore?`, `limit`) | 200 + `{flows: [...]}` |
| GET | `/flows/waiting` | wait lookup (system-waker / admin) | (query: `waitKind`, `channel?`, `threadId?`, `peer?`, `correlationId?`, `dueAtBefore?`) | 200 + `{matches: [{flowId, revision, waitInstanceId, controllerId, waitJson}, ...]}` (waitJson partially redacted; stateJson omitted) |
| POST | `/flows/:id/resume-via-callback` | external-call webhook (no Bearer; correlationId is the capability) | `{correlationId, payload?}` | 200 + record on success; 401 if correlationId mismatch; 410 if already consumed; 422 if status != waiting or wait kind != external-call. The supplied `correlationId` MUST match `waitJson.correlationId`; the registry uses the matched record's `waitInstanceId` and `revision` for the resume internally. |

Error codes: see "Conflict result shape" above. All error responses are JSON. The endpoint set above is the complete v1 surface; further endpoints (e.g., bulk-list, flow visibility for cross-agent peers) are out of scope.

## Migration Plan

### Phase 1: Skeleton + storage + maintenance sweeper (one PR)
- Add `src/tasks/TaskFlowRegistry.ts`, `src/tasks/task-flow-registry.store.sqlite.ts`, `src/tasks/TaskFlowMaintenanceSweeper.ts`, `src/tasks/TaskFlowDueWaker.ts`.
- Add `.instar/.gitignore` entry for `task-flows.db*`.
- Server endpoints per the API table above. All require `expectedRevision` for mutations except `createFlow` (idempotency-keyed) and `getFlow` (read-only).
- `TaskFlowMaintenanceSweeper`: hourly, marks `lost` via `markLost` (reserved controllerId, OCC-bumping) per the normative "Sweeper threshold policy" table (per-status / per-wait-kind, using `controllerHeartbeatAt` for `running` and `waitStartedAt` + `wait_kind` for `waiting`). Configurable via `taskFlow.thresholds`.
- `TaskFlowDueWaker`: minute-tick, fires `resumeFlow` for `waiting` flows whose `waitJson.kind == 'scheduled-tick'` and `dueAt <= now`.
- Tests: OCC conflict detection (404 vs 409 vs 410), all legal transitions, all illegal-transition rejections, idempotent createFlow under retry, waitInstanceId-based resume idempotency, sweeper lost-marking with simulated stale heartbeat, due-waker firing.
- No business consumers yet.

### Phase 2: ThreadlineFlowBridge + cross-agent-callback waits (one PR)
- Add `src/tasks/ThreadlineFlowBridge.ts` hooked into `MessageRouter`'s receive pipeline.
- Identity verification uses `MessageSecurity` envelope's verified-sender field; failure to verify is hard-reject before bridge inspection.
- End-to-end test: Echo creates a flow, `setFlowWaiting({kind:"cross-agent-callback", ..., correlationId})`, Dawn replies via Threadline with that correlationId, bridge verifies signature, flow resumes.

### Phase 3: EvolutionManager migration (two PRs)

#### Phase 3a: dual-write with divergence detection
- Refactor EvolutionManager bug-cluster pipeline to write through TaskFlow APIs.
- For backward compatibility, the existing JSONL files (`proposals.jsonl`, `dispatch-decisions.jsonl`) continue to be written. **TaskFlow is read-authoritative**; JSONL is shadow-write only. Reads come from TaskFlow.
- Backfill existing in-flight clusters into TaskFlow records as part of PR landing.
- Add `DivergenceChecker` cron (every 15 min) that:
  - reads recent JSONL state into a memory model;
  - compares to TaskFlow state on `(ownerKey, status, currentStep, waitJson.kind)`;
  - emits `taskflow_divergence_count` metric and a `note` to SharedStateLedger on any mismatch;
  - halts new shadow writes (alerts only) on `divergence_count > 0`.

#### Phase 3b: remove shadow JSONL writes
- Cutover criterion: `divergence_count == 0` for `>= 7 consecutive days`, AND ledger contains zero `taskflow-divergence` notes in that window.
- PR removes the JSONL shadow writes, removes `DivergenceChecker`. JSONL files become read-only artifacts of the prior history.

### Phase 4: InitiativeTracker migration (one PR)
- Replace InitiativeTracker's internal state with TaskFlow consumption.
- Phases → `currentStep`, blockers → `setFlowWaiting`.
- Backfill existing initiatives.

### Phase 5: Hardening + cache-eviction tuning (one PR)
- Per-controller flow-creation rate limits (default: 10/sec); max active flows per controller (default: 50); reject with `quota_exceeded` on overflow.
- LRU cache eviction tuning based on observed memory.
- Audit ledger emission for terminal transitions.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Migration leaves orphaned in-flight clusters in JSONL** | Phase 3a shadow-writes JSONL while reading authoritatively from TaskFlow. `DivergenceChecker` (15min cron) emits ledger-note alerts on any mismatch. Phase 3b cutover requires `divergence_count == 0` for `>= 7 days`. |
| **Single-writer assumption violated by future ops requirement** | Documented as v1 constraint. If multi-writer needed later, leader-election or per-row lease layer is a follow-up spec; the OCC contract already exists. |
| **Wait-arrival handler crashes between resume and step advancement** | Resume is idempotent at the registry (`waitInstanceId` consumption); the controller's step advancement is its own concern. Documented contract: controllers must be idempotent on resume. |
| **`scheduled-tick` waits never fire (clock skew, missed ticks)** | `TaskFlowDueWaker` polls every minute; missed ticks are picked up on next cycle. `dueAt` is wall-clock, server-relative; clock skew >1min would defer rather than skip. |
| **Cross-agent-callback wait never fires (peer dies, threadline disconnects)** | `TaskFlowMaintenanceSweeper` marks long-`waiting` flows `lost` after configurable threshold (default: 7 days for `cross-agent-callback`, 6 hours for `running`). Justin can `requestFlowCancel` from a CLI / dashboard. |
| **Optimistic-concurrency conflicts produce confusing errors** | `revision_conflict` returns include `current` flow snapshot; documented retry-with-current pattern. Distinct error codes for `revision_conflict` (409), `not_found` (404), `already_terminal` (410), `unauthorized_controller` (422), `already_consumed` (422). |
| **TaskFlow becomes a generic todo list** | Hard requirement: every flow has a `controllerId`; no "shared" controllers; no "any subsystem resumes" semantics; enforced server-side. |
| **Sweeper steals an alive but slow controller's flow** | Heartbeat contract: `pingFlow` is cheap (no revision bump). Long-running steps must ping at `HEARTBEAT_INTERVAL_MS`. If the sweeper still wins (controller missed pings), the orphan-detection note in SharedStateLedger flags the side-effect mismatch for human review. |

## Threat Model

- **Spoofed resume**: a hostile process with the auth token calls `resumeFlow` for a flow whose `controllerId` it is not. Mitigated by:
  - HTTP API loopback-only binding by default; explicit opt-in to expose via tunnel.
  - `Authorization: Bearer <auth-token>` required on every mutation.
  - Resume requires `waitInstanceId`. The waitInstanceId is generated server-side at `setFlowWaiting` time and travels back to the controller in the `setFlowWaiting` response. The wait-fire callback path (e.g., `ThreadlineFlowBridge`) holds the waitInstanceId in server memory; a hostile auth-token holder cannot guess it.
  - `controllerId` on resume must match the flow's `controllerId`; mismatch → `unauthorized_controller`.
- **Wait-callback injection (cross-agent-callback)**: a malicious Threadline peer attempts to fire someone else's wait. Mitigated by:
  - `correlationId` is ≥128 random bits, single-use; stored only in `waitJson` and in the original outbound message (sent over the encrypted Threadline channel — so an attacker would need to break Threadline's transport encryption to read it).
  - `expectedAgentId` matching uses **the verified-sender identity recovered from `MessageSecurity`'s signature verification**, never the message's plaintext `from:` field.
  - First successful `resumeFlow` consumes the `waitInstanceId`; replay of the same callback returns `already_consumed`.
- **Flow flooding**: per-controller flow-creation rate limits (default: 10/sec) and max-active-flows-per-controller cap (default: 50). Excess creates rejected with `quota_exceeded`.
- **State leakage via `stateJson`**:
  - Audit ledger notes log only `flowId`, `revision`, `currentStep`, `from_status`, `to_status`, `waitJson.kind`.
  - GET `/flows/:id` returns full record only when caller's `controllerId` matches; otherwise returns redacted shape (no `stateJson`, no `waitJson` content beyond `kind`).
  - `.instar/task-flows.db` is on the git-sync deny-list. Cross-machine sync of flow state is not supported in v1.
- **Replay attacks on callbacks**: `expectedRevision` defends against stale-overwrite races, NOT against semantic callback replay. The defense for callback replay is `waitInstanceId` consumption (see "Wait-callback injection"). Earlier draft conflated these.
- **Heartbeat flood (DoS)**: A buggy or malicious controller pings at maximum rate, consuming server CPU. Mitigated by per-controller rate limits (default: 60 pings/min/flow, configurable; surplus pings rejected with 429) added in Phase 5; the cheap-ping design (no revision bump) keeps the per-call cost low even at flood rates.
- **Sweeper-vs-controller race**: `TaskFlowMaintenanceSweeper` competes with a still-alive controller via OCC. If the sweeper marks `lost` at revision N+1 and the controller tries `finishFlow` at revision N, the controller's call fails with `revision_conflict` and `current.status='lost'`. The controller's documented retry path is: re-read flow; if status is `lost` and the controller still has uncommitted real-world side effects, it MUST emit a `note` to SharedStateLedger describing the side-effect orphan. This is rare (only happens when heartbeats are missed for >`LOST_THRESHOLD_MS`) and the alert lives in the ledger for human follow-up.

## Open Questions

1. **Multi-process controllers** — Resolved for v1: enforced single-writer (the server). Followup if needed: leader-election or per-row lease layer in a separate spec.
2. **Flow archival** — Open. Succeeded/failed flows older than N days: keep in DB or compact to per-`ownerKey` summaries? Recommendation: keep all in DB until cumulative row count exceeds 100k or table size exceeds 200 MiB; revisit then.
3. **Notification policy** — Resolved: defined Instar-specific `TaskNotifyPolicy` in Record Shape; not adopting OpenClaw's exact semantics.
4. **`requesterOrigin`** — Resolved: defined `RequesterOrigin` in Record Shape (replaces OpenClaw's `DeliveryContext`).
5. **Cross-agent flow visibility** — Open. Does Dawn need to see Echo's flows that are waiting on her? Recommendation: defer; v1 is internal to one agent. If added later, the receiving agent gets a redacted shape (no `stateJson`, no `ownerKey`) plus a stable `flow-handle` token.
6. **Privacy scope on flows** — Resolved: `privacyScope` field added; copies the `MemoryEntity` vocabulary.
7. **Sweeper threshold per wait kind** — Resolved: see the normative "Sweeper threshold policy" table in the Mutation Semantics section.
8. **`pingFlow` granularity** — Resolved: pingFlow updates `controllerHeartbeatAt`, `updatedAt`, and `controllerInstanceId` without bumping `revision`. Concurrent readers may see a different `updatedAt` than the revision they cached; nothing depends on `updatedAt` matching a specific revision.

## Non-Goals

- **Not a workflow DSL.** TaskFlow is plumbing, not Lobster. Instar is not adopting OpenClaw's Lobster orchestration language.
- **Not replacing JobScheduler.** JobScheduler runs cron-style recurrences; TaskFlow runs single-instance multi-step jobs.
- **Not replacing SharedStateLedger.** The ledger is still the durable counterparty-aware authority record; TaskFlow handles the "open work in progress" use case adjacent to it.
- **Not replacing CommitmentSweeper.** Commitments declare a future obligation with a mechanism; flows track active in-progress work. They are different shapes for different needs.
- **Not exposing `stateJson` in any UI.** Controller-private.

## Review Decisions

This section records concrete decisions made during the convergence review (Round 1, 2026-05-07/08) that explain why some reviewer findings were addressed differently than suggested or deferred.

- **Sweeper as reserved-controller writer (vs pure signal-shape)**. GPT and Grok both flagged that Principle 6 ("sweeper never mutates") contradicted Phase 5 ("server sets status=lost"). Round 1 picks the writer model: the sweeper holds a reserved `controllerId: "TaskFlowMaintenance"` and writes through normal OCC. Audit ledger notes still emit, for human-visible "why was this marked lost?" context, but they no longer carry status authority. This breaks symmetry with `CommitmentSweeper` (which is signal-shape); the asymmetry is justified because flows are state machines requiring a single answer for "current status?", whereas commitments are utterances we observe and re-interpret over time.

- **JSONL DR companion dropped**. All three external reviewers (GPT, Gemini, Grok) flagged dual-write atomicity as a BLOCKER. SQLite WAL is a durable journal on its own; adding an app-level append log gives no recovery power that SQLite + Backup System doesn't already provide, and it introduces a bug class. Dropped from v1.

- **`syncMode` and `blocked` status removed**. GPT flagged both as imported-from-OpenClaw baggage with undefined semantics in the Instar context. v1 schema is `managed`-only (implicit) and `waiting`-only (no separate `blocked`). Easier to add later than to remove.

- **Single-writer (the server) chosen for v1**. Gemini and Grok both raised the cache-coherence problem. We didn't redesign cache invalidation across processes; we made the writer set explicitly singular. This sidesteps the problem and matches Instar's actual architecture (the server owns its state). Multi-writer is a follow-up spec if the operational need appears.

- **Heartbeat via `pingFlow` (no revision bump)**. Adding heartbeat semantics resolves Grok's controller-identity finding and the adversarial sweeper-vs-controller race. `pingFlow` updates `controllerHeartbeatAt` and `updatedAt` but doesn't bump `revision`; this keeps the heartbeat cheap (no `expectedRevision` ping-pong) and makes the lost-detection rule deterministic.

- **`scheduled-tick` via `TaskFlowDueWaker`, not JobScheduler one-shot**. Integration review found JobScheduler is cron-only. Rather than expand JobScheduler with one-shot semantics in the same PR, Phase 1 ships a tiny dedicated waker. JobScheduler one-shot support can be added later in its own spec if the use case generalizes.

- **`ThreadlineFlowBridge` is a new module**. The original spec named `ThreadlineGateway`, which doesn't exist in Instar. The actual integration point is `MessageRouter`'s receive pipeline; `ThreadlineFlowBridge` is the new module that hooks into it for `cross-agent-callback` waits.

- **Identity verification for cross-agent callbacks uses `MessageSecurity` envelope**. Security review found `expectedAgentId` matching against the message's claimed `from:` field is spoofable. v1 uses the verified-sender recovered from signature verification. This makes the bridge trust the same identity mechanism Threadline uses for signed-message authentication.

- **`waitInstanceId` for callback idempotency**. GPT's "callback duplicate hits" finding led to adding `waitInstanceId` (server-generated uuid at `setFlowWaiting`, required as input to `resumeFlow`, consumed atomically). This is a stronger defense than `expectedRevision` for semantic replay across multiple revisions.

- **Per-kind LOST_THRESHOLD**. Adversarial review found a global 6h threshold would mark legitimate `human-review` flows lost while users sleep. Threshold is now per wait kind, with `scheduled-tick` exempt entirely.

- **String size limits and `waitJson` schema validation**. Minor findings (GPT, Grok) addressed inline in Record Shape and Storage sections. Validation is strict-on-write; the registry rejects malformed `waitJson` rather than letting invalid records persist.

- **System-waker carve-out (Round 2/3)**. Gemini found that wakers calling `resumeFlow` would fail the `unauthorized_controller` check since the flow's controllerId is e.g. `EvolutionManager`, not `TaskFlowDueWaker`. The fix: add a `system-waker` principal scope that is allowed to make the `waiting → running` transition only, with a matching `waitInstanceId`. The owning controller picks up via `EventBus`. This preserves the controller-owns-step principle without requiring wakers to impersonate the controller.

- **In-process direct registry calls vs HTTP API (Round 3)**. GPT flagged the wait-resolution path lacked an API for non-flowId lookups. Resolved by adding `findWaiting*` registry methods (callable in-process) and the matching `GET /flows/waiting` endpoint (callable over HTTP for admin/system-waker). System-waker callers run in-process and prefer the direct method; the HTTP endpoint exists for completeness and admin tooling.

- **`pingFlow` re-binds `controllerInstanceId` (Round 3)**. Grok identified that pingFlow's strict instanceId equality check would block re-attach after a server restart. Fix: pingFlow validates only `controllerId == caller.controllerId && status='running'` and OVERWRITES the stored `controllerInstanceId` with the supplied one. This makes the first ping after a restart the natural re-attach signal.

- **External-call callback uses correlationId as capability token (Round 3)**. Gemini observed external services don't have the Bearer token. Fix: `POST /flows/:id/resume-via-callback` does not require a Bearer token; the ≥128-bit `correlationId` IS the capability. This matches the security design where correlationId travels only through encrypted channels.

- **Cancel-while-waiting wakes the controller via EventBus (Round 3)**. Gemini observed that without a wakeup signal, a `requestFlowCancel` on a waiting flow would not be honored until the natural wait fired. Fix: `requestFlowCancel` emits `taskflow:cancel-requested` on EventBus when status=waiting; controllers register a handler.

- **`cancelFlow` is the right operation for honoring a cancel request (Round 2)**. Earlier draft text said controllers should "call failFlow with status: cancelled" — that was wrong because failFlow produces `status='failed'`. Use `cancelFlow` for `status='cancelled'`.

- **Deferred to follow-up specs (NOT addressed in v1)**:
  - Multi-writer / leader election. Out of scope; v1 is single-writer (the server).
  - Cross-agent flow visibility (Dawn sees Echo's flows). Out of scope; v1 is single-agent.
  - Flow archival policy beyond "keep until table size pressure". Open Question 2 stands.
  - Hoisting `wait_kind` / `wait_deadline` into top-level columns (Gemini's M3). Deferred. v1 sweepers iterate `(status='waiting', updated_at < threshold)` which uses an indexed scan; full waitJson parsing happens only on the (small) candidate set. Revisit if profiling shows the JSON parse step matters.
  - `reply` vs `cross-agent-callback` merge (GPT minor). Deferred; the two have different identity-verification mechanisms today (`peer` for `reply` is a Telegram peer, `expectedAgentId` for `cross-agent-callback` is a Threadline-signed identity), and merging them now would muddle that boundary.

## References

- OpenClaw (commit `f482e4d335`): `src/tasks/task-flow-registry.ts:376-586`, `src/tasks/task-flow-registry.types.ts:14-43`, `src/tasks/task-flow-registry.store.sqlite.ts:361-371`, `src/plugins/runtime/runtime-taskflow.ts` (consumer pattern), `src/tasks/task-flow-runtime-internal.ts` (internal helpers)
- Echo audit: `.claude/research/openclaw-audit-instar-2026-05-07.md` §2, §8 #1, §10 Q1
- Instar adjacent: `src/core/SharedStateLedger.ts`, `src/core/CommitmentSweeper.ts`, `src/core/InitiativeTracker.ts`, `src/core/EvolutionManager.ts`, `src/scheduler/JobScheduler.ts`, `src/messaging/MessageRouter.ts`, `src/threadline/ThreadlineRouter.ts`, `src/threadline/MessageSecurity.ts`
- Instar pattern reference: `docs/signal-vs-authority.md`
- Convergence report: `OPENCLAW-IMPORT-TASKFLOW-CONVERGENCE-REPORT.md` (alongside this spec)
