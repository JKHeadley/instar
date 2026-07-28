---
title: SleepWakeDetector — recurring-drift guard for the moderate-load band
status: converged
author: echo
created: 2026-06-15
eli16-overview: "sleepwake-false-fire-under-load.eli16.md"
review-convergence: self-converged (autonomous run; high-risk surface — Phase-5 second-pass review applied)
approved: true
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
relates-to: CMT-1563
---

# SleepWakeDetector — recurring-drift guard for the moderate-load band

## Problem (grounded in live evidence, 2026-06-15)

On an actively-used host the `SleepWakeDetector` can still emit **false wake events**, each of
which fires the full wake-recovery cascade (tunnel restart, Slack reconnect, mesh-lease churn,
topic failover). That cascade is the observed root cause of a class of "multi-machine UX failures":
a reply that doesn't know the conversation history (a failover respawn), messages that get no reply
(lease churn), and "remote typing is disabled" (the session moved machines mid-cascade).

### What the existing guards already catch — and the band they miss

The detector reads sleep by **timer drift** (a 2 s interval firing seconds late). Drift has two
causes: real OS sleep, and event-loop starvation under CPU load. The class already distinguishes
them with three guards:

- `maxLoadRatio` (default **1.5**) — a short drift while `loadavg[0]/cpuCount > 1.5` is starvation → suppress.
- `driftBurstSuppressFloor` (default **2**) — the 2nd+ **back-to-back** drift is a storm → suppress.
- `minWakeIntervalMs` (default **60 s**) — rate-limits emitted wakes.

The **gap** is a host oversubscribed only *moderately* — `loadRatio` just above **1.0/core** but
**below 1.5** — where the event loop stalls *intermittently*, ~every couple of minutes:

- The 1-minute `loadavg[0]` sits **below `maxLoadRatio`**, so the load guard never trips.
- On-time ticks fall **between** the drifts, so the consecutive counter resets and the **burst
  floor never trips** (each drift is `consecutiveDrifts == 1`).
- The ~2-minute cadence **outlasts the 60 s cooldown**.

So each isolated drift emits a FALSE wake. Measured on 2026-06-15: `loadavg 18/16 cores ≈ 1.13/core`
(below 1.5), `[SleepWakeDetector] Wake detected after ~33s sleep` / `~21s sleep` roughly **every 2
minutes** while the host was actively in use — driving the reported cascade.

## Goal

A SHORT drift that **recurs** on a **moderately-loaded** host must NOT emit a wake. A genuine
isolated sleep, any drift on a lightly-loaded host, and every long (real) sleep must STILL emit.
Fail-safe direction: a missed real sleep merely delays a tunnel/relay refresh until the next
inbound; a false sleep triggers a disruptive cascade — the asymmetry favors suppression for the
recurring-under-load case only.

## Design (shipped)

Add **one** cheap, platform-neutral signal — *recurring-drift memory* — to the short-drift path
(the `longSleepFloorSeconds` real-sleep bypass and the cooldown are unchanged):

> A SHORT drift within `recentDriftWindowMs` of a **prior** short drift, while
> `loadRatio > recentDriftLoadFloor`, is recurring CPU starvation → suppress (reason
> `cpu-starvation`). This generalizes the burst floor from *consecutive* ticks to *recent* ticks,
> and the load gate (`> recentDriftLoadFloor`, default **1.0**) confines it to the oversubscribed
> band the hard load guard (1.5) leaves open — so a recurring drift on a light/idle host (the
> existing "genuinely-isolated drifts both emit" behavior) is untouched.

Every short drift records its timestamp (`lastShortDriftAtMs`) whether emitted or suppressed, so the
recurrence window tracks the cadence. Classification order for a short drift
(`< longSleepFloorSeconds`): `burst-floor` → `load-guard` → **`recurring-drift` (new)** →
`cooldown` → emit. First matching suppressor wins.

### Config (all dark-compatible defaults; existing knobs unchanged)

```
recentDriftWindowMs?: number;   // default 300000 (5 min); 0 disables the guard (rollback lever)
recentDriftLoadFloor?: number;  // default 1.0 (oversubscription threshold)
```

Plumbed via `config.monitoring.sleepWake` exactly like `maxLoadRatio` (no ConfigDefaults / no
migration — the class default ships the fix to every agent on update). Set `recentDriftWindowMs: 0`
to restore exactly today's behavior.

## Non-goals (named follow-ons, not laundering)

- **Active-host signal** (suppress a drift overlapping recent inbound activity, via an injected
  `recentActivityAt()` provider) — defense-in-depth; recurrence-memory alone closes the measured
  gap, so this ships later rather than as unwired no-op code now.
- **Mesh-lease grace on a real brief sleep** (gap #3's lease side) — a separate increment; this spec
  stops the FALSE trigger, the dominant churn cause.
- Platform power-event integration (macOS `IOPMCopyAssertions`) — heavier, platform-specific.

## Testing (3-tier)

- **Unit (`tests/unit/sleep-wake-starvation-guard.test.ts`, new `describe`):** recurring short drift
  in the band (ratio 1.125) → 2nd suppressed; the SAME recurrence on a light host (ratio 0) → both
  emit (no regression of "isolated drifts both emit"); a genuinely isolated drift under band load →
  emits; `recentDriftWindowMs:0` → both emit (rollback lever); a recurring LONG sleep in the band →
  both emit (bypass unchanged). All 39 sleep-wake unit tests green.
- **Integration:** existing `sleep-wake-routes` / `sleep-wake-telemetry-lifecycle` exercise the
  construction + telemetry path; the new knobs flow through `config.monitoring.sleepWake`.
- **E2E posture:** the detector is constructed in the production `server.ts` boot path with the new
  knobs — the wake-recovery consumer is not invoked on a suppressed recurring drift.

## Risk / rollback

HIGH-risk surface (session-lifecycle / recovery trigger) → instar-dev **Phase 5 second-pass
review**. Ships behind back-compat defaults; `recentDriftWindowMs: 0` reverts with no logic redeploy.
Fail-safe: the change only ever ADDS suppression to a SHORT drift on an OVERSUBSCRIBED host; it never
suppresses a long (real) sleep, never changes the emit for an isolated drift, and never changes
behavior on a light/idle host.
