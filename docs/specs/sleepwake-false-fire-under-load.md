---
title: SleepWakeDetector — don't mistake CPU starvation for sleep (false-fire-under-load hardening)
status: draft
author: echo
created: 2026-06-15
eli16-overview: "sleepwake-false-fire-under-load.eli16.md"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "2026-06-15T20:00:00.000Z — converged via an independent Phase-5 second-pass review (adversarial audit of the over-suppression risk, ON-by-default posture, lastDriftAt ordering, rollback lever, and suppressor interaction): verdict CONCUR with one documentation note (applied)."
approved: true
approved-by: "echo (autonomous-run authority — pre-approved 24h multi-machine run on topic 13481; this is the root-cause fix for Justin's reported multi-machine UX failures, designed from live measured evidence). Ships with a rollback knob (windows → 0)."
relates-to: CMT-1563
---

# SleepWakeDetector — false-fire-under-load hardening

## Problem (grounded in live evidence, 2026-06-15)

On an actively-used, CPU-saturated host the `SleepWakeDetector` emits **false wake events**, each
of which fires the full wake-recovery cascade (tunnel restart, Slack reconnect, mesh-lease churn,
topic failover). That cascade is the observed root cause of a class of "multi-machine UX failures":
a reply that doesn't know the conversation history (a failover respawn), messages that get no reply
(lease churn), and "remote typing is disabled" (the session moved machines mid-cascade).

### Measured root cause

- `loadavg 18–24 on 16 cores` (sustained > 1.0/core) from many concurrent agent sessions + macOS
  Spotlight indexing accumulated worktrees → the Node event loop stalls **20–33 s** at a stretch.
- The detector detects sleep by **timer drift**: a 2 s interval that fires ~25 s late is read as
  "the process was suspended ~25 s (the machine slept)."
- Under starvation the timer ALSO fires late — drift alone cannot distinguish *real sleep* from
  *event-loop starvation*.
- The existing guards do not catch it on a saturated, actively-used host:
  - `loadGuardRatio` uses `loadavg[0]` — a **1-minute average that LAGS** a sudden CPU spike, so the
    first drift of a spike emits before the average reflects it.
  - `driftBurstSuppressFloor` (default 2) only suppresses the **2nd+ consecutive** drift — so the
    **first** drift of each repeating ~2-minute cycle still emits.
  - `longSleepFloorSeconds` (default 300 s) is a real-sleep bypass, but the false drifts (~21–33 s)
    are well under it, so this isn't the path here — the short-drift path is.
- Observed cadence: `[SleepWakeDetector] Wake detected after ~33s sleep` / `~21s sleep` roughly
  **every 2 minutes** while the host was actively in use (not sleeping).

## Goal

A short drift on an **actively-used host under sustained load** must NOT emit a wake. A genuine,
isolated sleep (the machine actually suspended) must STILL emit. Fail-safe direction: when in doubt,
**suppress** (a missed real sleep just delays a tunnel/relay refresh until the next inbound; a false
sleep triggers a disruptive cascade — the asymmetry favors suppression).

## Design

Add two cheap, platform-neutral corroboration signals to the short-drift classification (the
existing `longSleepFloorSeconds` real-sleep bypass and the cooldown are unchanged):

1. **Recent-drift memory.** Track the timestamp of the last classified drift. If another drift
   occurred within `recentDriftWindowMs` (default 300_000 = 5 min), classify the new **short** drift
   as `cpu-starvation` and suppress — a healthy host does not genuinely sleep-and-wake repeatedly
   every couple of minutes; repeated short drifts are the starvation signature. (This generalizes
   `driftBurstSuppressFloor`, which only caught *consecutive* ticks, to *recent* ticks — the false
   cycle is ~2 min apart, i.e. not consecutive 2 s ticks, which is exactly why the burst floor
   missed it.)

2. **Active-host signal.** If the host saw inbound user/mesh activity within `activeHostWindowMs`
   (default 120_000) of the drift, it was awake during that window — a "sleep" that overlaps recent
   activity is far more likely starvation. Injected via an optional `recentActivityAt()` provider
   (the server already tracks last-inbound per the activity sentinels); absent ⇒ this signal is a
   no-op (back-compat).

Classification order for a short drift (`< longSleepFloorSeconds`):
`cooldown` → `recent-drift` (new) → `active-host` (new) → `loadGuardRatio` → `burst-floor` → emit.
The first matching suppressor wins; only a short drift that clears ALL of them emits a wake.

A genuine isolated sleep clears all four: no recent drift (the host was running normally, single
isolated drift), no overlapping activity (the machine was actually off), load normal, not a burst.

### Config (all dark-compatible defaults; existing knobs unchanged)

```
recentDriftWindowMs?: number;   // default 300000; 0 disables signal 1
activeHostWindowMs?: number;    // default 120000; 0 disables signal 2
recentActivityAt?: () => number | null;  // injected; absent ⇒ signal 2 no-op
```

Tunable to `0` / omitted to restore exactly today's behavior — the rollback lever.

## Non-goals

- Platform power-event integration (macOS `IOPMCopyAssertions` / `NSWorkspace` notifications) — a
  reliable but heavier, platform-specific follow-up <!-- tracked: CMT-1563 -->. This spec stays
  platform-neutral (timers + injected signals) to ship the high-value 80% cheaply.
- The mesh-lease *grace* on a real brief sleep (gap #3's lease side) <!-- tracked: CMT-1563 --> — a
  separate increment; this spec stops the FALSE trigger, which removes the dominant cause of the churn.

## Testing (3-tier, false/true symmetric)

- **Unit (`SleepWakeDetector`):** with injected wall-clock + `recentActivityAt`:
  - Repeating short drifts (2 min apart, sustained) → NO wake emitted (recent-drift suppresses);
    each is recorded as `cpu-starvation` in the suppression counter.
  - A single isolated short drift, no recent drift, no recent activity, normal load → wake EMITTED
    (real brief sleep still works).
  - A drift overlapping recent activity → suppressed (`active-host`).
  - A long drift (≥ `longSleepFloorSeconds`) → wake EMITTED regardless (bypass unchanged).
  - All new knobs at `0`/absent → byte-identical to pre-change classification (back-compat).
- **Integration:** the wake-recovery consumer is NOT invoked on a suppressed drift (no tunnel
  restart / relay reconnect spuriously triggered).
- **E2E posture:** a simulated saturated-host drift cycle produces zero wake-recovery cascades.

## Risk / rollback

HIGH-risk surface (session-lifecycle / recovery trigger) → instar-dev **Phase 5 second-pass review
REQUIRED**. Ships behind the new knobs with back-compat defaults; set the windows to `0` to revert
to current behavior with no redeploy of logic. Fail-safe: the change only ever ADDS suppression to a
SHORT drift; it never suppresses a long (real) sleep and never changes the emit for an isolated
drift on an idle host.
