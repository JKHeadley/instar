---
title: Task Flows
description: Durable multi-step job records with optimistic-concurrency state machine.
---

When an agent's work spans multiple steps that need to be tracked, retried, and resumed across session boundaries, `TaskFlow` is the system that holds the state. It was imported from OpenClaw's task-flow-registry and adapted for instar's single-agent architecture. See `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` for the original design.

## Components

- **`TaskFlowRegistry`** — durable record store backed by SQLite. Each task flow is a row with a state, a step graph, and structured payload state JSON. Reads and writes use optimistic-concurrency tokens so concurrent updates can't silently overwrite each other.
- **`TaskFlowDueWaker`** — fires when a flow's scheduled wake time arrives. Wakes are stored with millisecond precision; multiple flows due at the same time get batched into a single waker pass.
- **`TaskFlowMaintenanceSweeper`** — runs periodically to retire completed flows, archive failed ones, and surface flows that have stalled past their expected duration.
- **`ThreadlineFlowBridge`** — connects task flows to the Threadline relay surface, so flows can span multiple agents (one agent kicks off a flow, another agent picks up a step, the flow lifecycle stays coherent across both).
- **`DivergenceChecker`** — watches for state mismatches between what a flow expects and what actually happened (e.g. a step claimed completion but the side effect isn't visible). Surfaces divergences to the remediator.
- **`LruCache`** — small in-memory cache for frequently-accessed flow records.
- **`RateLimiter`** — bounds how aggressively flows can fire new steps, especially relevant when many flows wake simultaneously.

## State machine

Each flow moves through a constrained state graph: `pending → running → waiting → running → finished` (or `failed`, or `cancelled`). Transitions are atomic and journaled. The optimistic-concurrency token ensures that two parallel attempts to advance the same flow get one success and one transition-conflict error rather than corrupting state.

## When to use a task flow vs a job

| Use case | Pick |
|----------|------|
| One-shot work on a cron schedule | [Job scheduler](/features/scheduler) |
| Long-running work with multiple async steps | Task flow |
| Work that has to coordinate across agents | Task flow with `ThreadlineFlowBridge` |
| Stateless health check | Job |
| Multi-step user request that may pause for input | Task flow |

The two systems interoperate. A scheduled job can launch a task flow as its body; a task flow can schedule a job for one of its steps. The split is about state durability — task flows persist their state across server restarts and session boundaries; jobs don't unless they explicitly write state somewhere themselves.

## API

| Endpoint | Description |
|----------|-------------|
| `POST /flows` | Create a new flow |
| `GET /flows/:flowId` | Read flow state |
| `GET /flows/waiting` | List flows currently waiting on something |
| `POST /flows/:flowId/start-step` | Begin a step |
| `POST /flows/:flowId/finish` | Mark the flow as completed |
| `POST /flows/:flowId/fail` | Mark the flow as failed (with reason) |
| `POST /flows/:flowId/wait` | Suspend until a wake condition |
| `POST /flows/:flowId/ping` | Heartbeat for long-running steps |
| `POST /flows/:flowId/resume` | Resume from wait |
| `POST /flows/:flowId/cancel-flow` | Cancel the whole flow |
| `POST /flows/:flowId/cancel-request` | Request cancellation (the flow can decline) |
| `POST /flows/:flowId/mark-lost` | Mark a flow as unrecoverable |

## What's in the SQLite store

Flow records live in `task-flow-registry.store.sqlite.ts` (with adjacent WAL and SHM files). State JSON can contain user-supplied content, so the store is treated as containing PII and is gitignored.
