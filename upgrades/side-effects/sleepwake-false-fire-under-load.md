# Side-Effects Review — SleepWakeDetector false-fire-under-load hardening

**Version / slug:** `sleepwake-false-fire-under-load`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `required + DONE` — independent Phase-5 adversarial review (session-lifecycle/detector change). Verdict: **Concur** with one documentation note (the ON-by-default rationale comment), which has been applied. The reviewer validated: `lastDriftAtMs` ordering correct; rollback lever (windows→0) correct + tested; suppressor ordering sound (no double-suppression); over-suppression trade-off acceptable given the fail-safe direction + the long-sleep exemption.

## Summary of the change

`SleepWakeDetector` was misreading a 20–33s event-loop stall on a CPU-saturated host as a "~25s sleep" and firing the wake-recovery cascade (tunnel restart, Slack reconnect, mesh-lease churn, topic failover) ~every 2 min. Root cause: the existing `driftBurstSuppressFloor` guard only catches BACK-TO-BACK drifts; the false cycle is ~2 min apart (on-time ticks between reset `consecutiveDrifts`), so each drift looks isolated and emits. This is the measured root cause of a class of multi-machine UX failures (a failover respawn that lost history; no-reply lease churn; "typing disabled").

Adds two suppressors to the SHORT-drift path (`src/core/SleepWakeDetector.ts`); long sleeps (`>= longSleepFloorSeconds=300`) stay always-emit:
1. **recentDriftWindowMs** (default 300000, ON): a `lastDriftAtMs` TIMESTAMP (not the consecutive counter) — a new short drift within the window is starvation, suppressed. This is the suppressor the burst-floor misses.
2. **activeHostWindowMs** (default 120000) + injected `recentActivityAt()` provider (absent ⇒ no-op): a short drift overlapping recent inbound activity is starvation (the host was demonstrably awake), suppressed.

## Decision-point inventory

- `recentDriftWindowMs` short-drift suppressor — **NEW, ON by default** — the fix; suppresses a repeating short-drift cycle. Long sleeps exempt. `0` ⇒ disabled (rollback).
- `activeHostWindowMs` short-drift suppressor — **NEW, inert by default** — no-op unless a `recentActivityAt` provider is wired (this PR adds the option, not the wiring — wiring the server's last-inbound source is a tracked follow-on; the recent-drift suppressor alone fixes the observed bug). `0` ⇒ disabled.
- Existing burst-floor / load-guard / cooldown / long-sleep — **unchanged**.

## 1. Over-block
A genuine REPEATED short sleep (a real sleep < 300s, twice within 5 min) has its 2nd wake suppressed → its dropped sockets reconnect on next activity instead of immediately. Bounded + acceptable: the 1st sleep already recovered; the long-sleep exemption (>=300s always emits) covers any real extended sleep; an actively-used host gets activity (and reconnection) promptly. Fail-safe rationale: a missed wake delays a refresh (mild); a false wake cascades (the bug).

## 2. Under-block
A starvation cycle whose drifts are spaced > `recentDriftWindowMs` (5 min) apart AND with no overlapping activity AND momentary low load would still emit. Mitigated by the active-host signal once wired; the 5-min window comfortably covers the observed ~2-min cadence.

## 3. Level-of-abstraction fit
Correct layer. The discrimination belongs in the detector (it owns "is this drift real sleep?"). No new component; two cheap, platform-neutral signals + an injected provider for testability — mirrors the existing `loadAvgProvider`/`nowProvider` injection pattern.

## 4. Signal vs authority compliance
Compliant. The detector is a SIGNAL producer (emits a `wake` event); recovery consumers decide what to do. This change only makes the signal MORE accurate (fewer false positives). It never blocks/gates anything; the fail-safe direction is to stay silent on doubt. Per `docs/signal-vs-authority.md`.

## 5. Interactions
Verified by the second-pass: the new suppressors slot between burst-floor and load-guard; each is an early-exit `return` after `recordSuppression`; suppressed drifts do NOT update `lastEmittedWakeAtMs` (cooldown unaffected) and DO update `lastDriftAtMs` (so the cycle is tracked). No double-fire, no mis-order. `consecutiveDrifts` still resets on any on-time tick (unchanged).

## 6. External surfaces
Behavior change is internal (fewer spurious `wake` events → fewer tunnel/Slack/lease recovery cascades on a saturated host). Visible to the user only as the ABSENCE of the disruptive cascade. No API/schema/message change. Multi-machine posture: machine-LOCAL by design (each machine runs its own detector against its own event loop — there is nothing to replicate; the fix reduces cross-machine churn by not falsely triggering failover).

## 7. Rollback cost
Trivial + instant, no redeploy of logic: set `recentDriftWindowMs: 0` (and `activeHostWindowMs: 0`) in config → exact pre-fix behavior (a dedicated test asserts byte-identical legacy behavior at 0). No migration, no state. Worst case (over-suppression complaint) → flip the knob.

## 8. Testing
16 unit tests pass (9 existing + 7 new, false/true symmetric): repeating short-drift cycle SUPPRESSED; isolated short sleep after quiet STILL emits; long sleep within the window STILL emits (exemption); active-host suppression; active-host no-op without a provider (back-compat); both windows at 0 = legacy behavior; existing stats/lifecycle tests preserved (two updated to isolate the new suppressor with `recentDriftWindowMs:0`). `tsc --noEmit` clean.
