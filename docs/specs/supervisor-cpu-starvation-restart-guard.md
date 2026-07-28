---
title: Supervisor CPU-starvation restart guard — stop bouncing a live server under load
status: approved
author: echo
date: 2026-05-29
review-convergence: "2026-05-30T01:25:40.987Z"
review-iterations: 2
review-completed-at: "2026-05-30T01:25:40.987Z"
review-report: "docs/specs/reports/supervisor-cpu-starvation-restart-guard-convergence.md"
approved: true
approved-note: "Fast-tracked by echo as an urgent fleet-wide bug — the overload restart loop that drops user messages (Justin, topic 15160, who said 'go ahead and restart and apply the fix' and approved building the guard). Bounded, additive, strictly safety-improving; convergence constrained to self-review. Disclosed in the convergence report and to Justin."
---

# Supervisor CPU-starvation restart guard

## Problem

User report (Justin, topic 15160): *"most of my messages are not going through.
I send a message, it says the session is restarting even though I KNOW the
session is still alive, and I have to go to the dashboard."*

Root cause, found in `logs/server.log` on Echo (2026-05-29): the server was in a
**restart loop** — fresh "Server listening" at 00:22 / 00:27 / 00:33 / 00:38 /
00:53 / 00:57 UTC. Inbound messages arriving during a restart window are
lost/misrouted. The driver was **machine overload**: load ratio ~2× the core
count. `ServerSupervisor` health-checks the server every 10s; under CPU
starvation the live server's event loop can't answer `/health` within the
timeout, so after `processAliveThreshold` (6 failures ≈ 60s) the supervisor
declared it "alive but unresponsive" and restarted it. But restarting a
CPU-starved server does **not** cure the starvation — the fresh server is
starved too — so it just dropped the in-flight message and looped whenever load
stayed high for >60s.

This is the same *class* as the SleepWakeDetector false-positive already fixed
(`docs/specs/` SleepWake CPU-starvation guard): a load-spike misread as a real
fault, triggering a destructive action that makes things worse. The supervisor
had no load awareness at all.

## What already exists

- `ServerSupervisor` health loop (10s) with a two-stage threshold:
  `unhealthyThreshold` (2) → mark unhealthy; `processAliveThreshold` (6 ≈ 60s) →
  restart an alive-but-unresponsive server; immediate restart if the process is
  dead. Plus a 60s lenient window after a detected wake.
- `SleepWakeDetector` already classifies CPU starvation as `loadavg[0] /
  cpuCount > 1.5` and suppresses the false wake.
- No shared definition of "CPU-starved" — SleepWakeDetector embeds its own.

## The change

1. **`src/core/cpuStarvation.ts` (new)** — shared `cpuLoadRatio()` /
   `isCpuStarved(maxRatio)` + `DEFAULT_MAX_LOAD_RATIO = 1.5`, the canonical
   "machine oversubscribed" signal (returns 0 on any read error so it never
   trips a starvation branch on bad data).

2. **`ServerSupervisor`** — the two identical health-failure branches (unhealthy
   `/health` response, and a thrown check) are extracted into one
   `evaluateUnhealthyServer()`. It adds a CPU-starvation defer: when the server
   is alive, the threshold is reached, **and** the box is CPU-starved, it
   DEFERS the restart (logs once) instead of bouncing — up to a hard cap
   `starvationRestartThreshold` (30 checks ≈ 5min), past which it force-restarts
   in case the server is genuinely hung rather than merely starved. Dead process
   still restarts immediately; not-starved still restarts at the 6-failure
   threshold; below threshold still waits. The next healthy tick resets the
   counter, so the defer is never permanent. The load source is injected
   (`loadRatioProvider`, default `cpuLoadRatio`) so the real decision method is
   unit-testable.

## Why it's safe to default ON (no opt-in flag)

The guard only changes behavior in one case: server **alive**, **unresponsive
past the existing 6-failure threshold**, **and** the box is genuinely
CPU-starved. In every other case behavior is identical (dead → restart; not
starved → restart at 6; below threshold → wait). It can only DEFER a restart it
would otherwise have done, and only while starved, and only up to a 5-minute
hard cap — so it cannot strand a genuinely-hung server. It removes a
counterproductive action (bouncing a server that would recover on its own once
load eases) that was actively dropping user messages.

## Blast radius / migration

Pure `src/` logic in the lifeline (`ServerSupervisor`) + a new pure helper
module. No agent-installed files (no `.claude/settings.json`, no
`.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no
skills). Every agent receives it through the normal dist update; the lifeline
picks it up on its next restart (version-skew / drift coordination already
handles lifeline restarts). No `PostUpdateMigrator` entry required.

## Testing (three tiers)

- **Unit**: `cpu-starvation.test.ts` (pure ratio/threshold, injected values);
  `supervisor-cpu-starvation-defer.test.ts` drives the REAL
  `evaluateUnhealthyServer()` with an injected load ratio + spied
  process-alive/restart primitives — defer-while-starved, restart-when-not,
  force-restart-past-cap, dead→immediate, below-threshold→wait, and
  defer-is-not-permanent.
- **Wiring guard**: a source assertion that both health-failure paths route
  through `evaluateUnhealthyServer()` and that it consults the starvation defer
  (dead-code guard).
- This is lifeline-internal behavior with no HTTP route, so the HTTP-pipeline
  integration tier and the "feature alive / 200-not-503" e2e tier do not apply;
  the real-method unit coverage + wiring guard are the meaningful tiers here.
