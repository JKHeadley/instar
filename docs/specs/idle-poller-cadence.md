---
title: Idle-aware poller cadence (IdleAwareCadence + TokenLedgerPoller)
slug: idle-poller-cadence
status: approved
review-convergence: 2026-05-31T02:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during an explicit
  5-hour autonomous run (topic 16782, 2026-05-30) on the Responsible Resource
  Usage standard. This is the first concrete slice of Level 1 (tool/idle sleep):
  instar's OWN background pollers backing off when the agent is idle. (instar
  can't hibernate Claude-Code-spawned MCP servers — see the standard's L1 note —
  so the in-scope win is reducing instar's own idle footprint.) Flagged in PR.
---

# Idle-aware poller cadence

## Problem

Each instar agent runs ~27 timer-driven background monitors. On an idle agent
(no active sessions) most of them still wake on a fixed cadence and do work —
JSONL scans, tmux captures, ledger rollups — even though nothing is happening.
Across ~9 always-on agent stacks on one box, that fixed-cadence churn is a real
slice of the always-on CPU floor the Responsible Resource Usage standard targets.

instar cannot hibernate the MCP servers (Claude Code spawns those from
`.mcp.json`), but it CAN make its own pollers cheaper when idle.

## Goal

A reusable primitive that lets any poller run at full cadence while active and
back off while idle, snapping back when activity resumes. Apply it first to the
clearest offender — `TokenLedgerPoller` (60s JSONL scan) — establishing the
mechanism that later pollers and agent-sleep (Level 3) build on.

## Non-goals

- Not converting all 27 pollers (incremental — this ships the primitive + one
  application; others adopt it in follow-ups, each verified safe to back off).
- Not agent-sleep itself (Level 3) — this is a building block for it.

## Design

`IdleAwareCadence` (`src/monitoring/IdleAwareCadence.ts`): a self-rescheduling
`setTimeout` loop. Each reschedule samples `isIdle()` and waits `idleMs` (idle) or
`activeMs` (active). Safety: `isIdle()` throwing ⇒ ACTIVE (never backs off on an
ambiguous signal); `tick()` throwing ⇒ swallowed (the loop survives). Because the
idle state is re-sampled on every reschedule, resuming activity restores full
cadence within at most one idle interval.

`TokenLedgerPoller`: gains optional `isIdle` + `idleIntervalMs` (default 5 min).
When `isIdle` is provided it drives ticks through `IdleAwareCadence` (active =
`intervalMs` 60s, idle = `idleIntervalMs`); otherwise it keeps the prior fixed
`setInterval` exactly (backward-compatible). `AgentServer` wires
`isIdle: () => sessionManager.listRunningSessions().length === 0` — scanning the
token JSONL when no session is running attributes nothing, so backing off is both
safe and correct.

## Decision points (signal vs authority)

No blocking authority. This only changes the *cadence* of a read-only
observability poller; it never gates information flow. `isIdle` ambiguity degrades
to full cadence (the prior behavior), so the failure mode is "no savings," never
"missed work." Per `docs/signal-vs-authority.md`, nothing here is brittle-with-authority.

## Testing

Unit: `IdleAwareCadence` with fake timers (active interval, idle backoff,
re-evaluation active→idle, isIdle-throw⇒active, tick-throw-survives, stop()), and
the `TokenLedgerPoller` wiring (backs off while idle, full cadence while active,
fixed cadence without `isIdle`). Existing TokenLedger/poller tests stay green.

## Rollback

Behavior-only, additive. Omitting `isIdle` restores the exact prior fixed cadence;
a PR revert removes the helper + the poller option. No config, no schema, no state.
