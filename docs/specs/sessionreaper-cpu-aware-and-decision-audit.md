---
title: SessionReaper — CPU-aware pressure + decision audit
slug: sessionreaper-cpu-aware-and-decision-audit
status: approved
review-convergence: 2026-05-30T21:45:00-07:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. The user (Justin)
  explicitly requested both capabilities in topic 16782 ("CPU Load
  Investigation") on 2026-05-30 — "we should consider adding CPU usage into the
  SessionReaper's evaluations" and "yes lets build that [the decision audit], as
  long as it doesn't create noise for the user, just better auditability". This
  spec formalizes the already-approved feature; the self-approval is flagged in
  the PR per the cross-agent-communication discipline.
---

# SessionReaper — CPU-aware pressure + decision audit

## Problem

The `SessionReaper` reaps idle-but-alive sessions only when the machine is under
pressure, and its pressure tier was computed **purely from free memory**
(`freemem/totalmem`). On a busy multi-agent host the real constraint is almost
always **CPU**, not RAM: free memory can look healthy (observed: 94% free) while
the 1-minute load average sits well past the core count (observed: load 12–17 on
a ~14-core box). In that regime the reaper never raised its tier, so genuinely
idle sessions — each carrying a baseline server + lifeline + poller footprint —
were never eligible for reaping under the exact load condition they could relieve.

Separately, when the reaper ran in dry-run it produced **no reviewable record**.
Its structured events were appended to the shared `sentinel-events.jsonl` and
only covered the reap path (`reap-pending`, `would-reap`, `reaped`, …); the
routine keep decisions were never recorded. So "what is the reaper considering,
and why is it keeping/killing each session?" had no grounded, inspectable answer.

This is level 2 (the session level) of the broader **Responsible Resource Usage**
fractal standard the user articulated (tool / session / agent sleep).

## Goals

1. Make reaper pressure **CPU-aware**: the tier is the WORST of the memory tier
   (free %) and a CPU tier (1-min load ÷ cores), so a CPU-bound box raises
   pressure even when free memory is fine.
2. Add a **silent, reviewable decision audit**: a dedicated trail of every
   keep/kill decision *change* plus the reap-path events, stamped with the
   pressure context, readable via a read-only endpoint. No user-facing noise.

## Non-goals

- No change to the safety classifier. The positive-idle proof, transcript-growth
  gate, render-stasis, hysteresis, confirmation window, two-phase reap, grace
  period, per-tick/per-hour budget, and auto-disable are all unchanged. The hard
  requirement — NEVER reap a working session — is untouched.
- Not turning the reaper on. It still ships OFF + dry-run by default.
- No new notifications, attention items, or Telegram surface.

## Design

### CPU-aware pressure

A new pure function `computePressure(inputs, thresholds)` is the single source of
truth for the tier:

- `memTier` from `freePct` (constants 12% → moderate, 5% → critical — the
  existing behavior, preserved).
- `cpuTier` from `loadPerCore = os.loadavg()[0] / os.cpus().length`, against two
  configurable thresholds `cpuModerateLoadPerCore` (default 1.0) and
  `cpuCriticalLoadPerCore` (default 1.5).
- `tier = worst(memTier, cpuTier)`.
- `loadPerCore: null` (cores unknown) or non-finite ⇒ CPU drops out ⇒ memory-only
  (the exact pre-change behavior). This keeps the function total and the
  migration risk-free.

The function is `os`-free (inputs are passed in) so it is fully unit-testable.
The server's pressure provider computes `freePct` + `loadPerCore` from `os` and
delegates to it. `PressureReading.inputs` now also carries `loadPerCore`,
`memTier`, and `cpuTier` for observability (surfaced in `GET /sessions/reaper`).

### Decision audit

- A dedicated sink `reaperAuditSink(stateDir)` writes to `logs/reaper-audit.jsonl`
  (separate from the shared sentinel log). `readReaperAudit(stateDir, limit)`
  reads the bounded tail; both never throw.
- The reaper emits a `decision` audit row **only on transition**: the first time
  it sees a session, and whenever the `(verdict, keptBy)` pair changes from the
  last audited value. A multi-day kept session logs once, not every tick — this
  is the low-noise guarantee. Each row carries the pressure `tier` + `inputs`.
- A read-only route `GET /sessions/reaper/audit?limit=N` returns the tail. Silent;
  no notifications.

## Decision points (signal vs authority)

The reaper IS an authority (it kills sessions), but this change does not add new
blocking authority. CPU-aware pressure only widens *when* the existing,
heavily-gated kill path may act; every safety gate still has to clear. The audit
is a pure signal producer (write-only observability) with zero authority. Per
`docs/signal-vs-authority.md`, no brittle check gains blocking power here.

## Config + migration

Two new fields under `monitoring.sessionReaper`: `cpuModerateLoadPerCore` (1.0)
and `cpuCriticalLoadPerCore` (1.5). Added to `ConfigDefaults.ts`; existing agents
receive them automatically through the canonical defaults registry
(`applyDefaults` deep-merges missing nested keys). New CLAUDE.md awareness reaches
existing agents via a content-sniffed `migrateClaudeMd` section.

## Testing

Three tiers: unit (`computePressure` matrix + transition-audit + sink round-trip),
integration (the audit route), e2e (feature-alive through the real AgentServer).
Plus the feature-delivery-completeness + capabilities-discoverability lints.

## Rollback

Pure additive change. Back-out is a revert of the PR; or operationally, the CPU
thresholds can be set absurdly high to neutralize CPU-awareness without a deploy,
and the audit is write-only (deleting the file or ignoring the route is harmless).
