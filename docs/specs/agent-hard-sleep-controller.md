---
title: Agent hard-sleep — SleepController decision foundation (Stage B, slice 1)
slug: agent-hard-sleep-controller
status: approved
review-convergence: 2026-05-31T03:45:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin directed
  (topic 16782, 2026-05-31) to build Stage B agent-sleep now, in-session, and not
  defer it. This is the first slice: the sleep DECISION logic + every safety
  guard, shipped dark + dry-run, so the "is it safe to sleep?" reasoning is proven
  and observable BEFORE the mechanism slice wires the mechanism that actually stops the
  server. Umbrella design: docs/specs/agent-sleep-mode.md (PR #594).
---

# Agent hard-sleep — SleepController decision foundation

## Problem

Stage B of the agent-sleep design (the deepest lever of the Responsible Resource
Usage standard) lets a deeply-idle agent drop its server to near-zero footprint and
wake on the next message. The risky part is the MECHANISM: the supervisor stopping
the server and the lifeline respawning it without losing a message. Before any of
that is wired, the DECISION — "is it actually safe for this agent to sleep right
now?" — must be correct and observable, because a wrong decision (sleeping while it
holds the multi-machine lease, or while a job is about to fire, or while work is in
flight) is how hard-sleep would brick an agent.

## What's new

`src/monitoring/SleepController.ts` — a pure, exhaustively-testable decision module:

- **`evaluateSleep(input, thresholds)`** returns one of four verdicts:
  - `awake` — a session is running, or activity within `idleGraceMs`.
  - `idle-shallow` — idle past grace but before `deepIdleMs`.
  - `keep-awake` — deep-idle but a **safety guard** blocks sleep.
  - `would-sleep` — deep-idle and every guard clear.
- **Safety guards** (any one ⇒ `keep-awake`, named in the reason): this machine
  holds the multi-machine serving lease; in-flight work (forward / recovery /
  queued message); a scheduled job fires within `wakeLeadMs`.
- **`SleepController`** ticks the decision on a cadence. It audits only on a
  decision TRANSITION (low-noise, like the reaper audit) to
  `logs/agent-sleep-events.jsonl`. In **dry-run (the default)** it never acts. In
  live mode (`enabled && !dryRun`, the mechanism slice wires the consumer) it calls
  `requestSleep` once per would-sleep episode.

Config (`monitoring.agentSleep`, default OFF + dry-run, mirrors the reaper):
`{ enabled: false, dryRun: true, tickIntervalSec, idleGraceMs, deepIdleMs, wakeLeadMs }`.
Status route `GET /sleep` exposes the latest verdict + thresholds for inspection.

## What is explicitly NOT in this slice

The mechanism: the supervisor consuming a sleep-request to stop the server, the
lifeline writing a wake-request + respawning + replaying the buffered message, and
the watchdog treating a slept agent as healthy. Those are the next slice; this one
ships the decision + guards dark so they can be validated against real agent
behavior first (does a real agent ever reach `would-sleep`, and was every
`keep-awake` correct?). <!-- tracked: topic-16782 -->

## Safeguards

- Default OFF + dry-run: the controller only observes; nothing stops a server.
- Every guard defaults to the SAFE side: unknown lease/in-flight/job state is
  sampled conservatively (treated as a reason to stay awake) so a sampling gap can
  never produce a spurious would-sleep in live mode.
- Signal-only in this slice — no blocking authority over any message.

## Testing

- Unit (`SleepController.test.ts`): both sides of every boundary (grace, deep-idle,
  each guard), exact-threshold boundaries, most-recent-of-inbound-vs-activity, the
  dry-run-never-acts contract, once-per-episode latching, and transition-only audit.
- Integration: `GET /sleep` returns 200 with the current verdict when enabled;
  503-stub semantics consistent with the other dark monitors when disabled.

## Rollback

Pure additive source + a default-off config block (auto-migrated, existence-checked).
Revert the commit → the controller and route disappear; nothing else changes. No
persistent state beyond the best-effort audit log.
