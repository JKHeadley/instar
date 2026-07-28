# Side-Effects Review — SystemReviewer on-boot refresh (fix stale "Degraded" panel)

**Version / slug:** `systemreview-onboot-refresh`
**Date:** `2026-06-23`
**Author:** Echo (autonomous)
**Tier:** 1 (one added on-boot review timer on a self-scheduling monitor; behavior-additive, behind a default-on flag, covered by 4 new unit tests)
**Second-pass reviewer:** not-required (Tier 1)

## Summary of the change

The SystemReviewer (the probe-health "system review" surfaced in `/health`, rendered as the dashboard health panel) runs a full review every `scheduleMs` (default 6h). But `start()` only set up the interval — it ran NO review on boot. On an agent that restarts more often than 6h (updates, recovery bounces, the dashboard-freeze restarts), the 6h timer resets on every boot and never fires, so the displayed review stays frozen at the last pre-restart boot. Observed live: the systemReview in `/health` was stuck at `2026-06-20T11:51` (the meltdown) — days stale, showing "critical / 11-of-16 probes passed" long after the box recovered.

## The change

- `src/monitoring/SystemReviewer.ts` — `start()` now schedules ONE on-boot review (`setTimeout`, default 30s delay, unref'd) in addition to the interval, gated by `shouldRunInitialReview()`: it runs only when the last persisted review is absent or older than `initialReviewStaleAfterMs` (default 1h), so a restart loop doesn't pile up reviews. An unparseable timestamp is treated as stale (run it — fail toward fresh). New config: `reviewOnStart` (default true), `initialReviewDelayMs` (30s), `initialReviewStaleAfterMs` (1h). `stop()` clears the new timer.
- `src/commands/server.ts` — forwards the three new config fields to the SystemReviewer so `reviewOnStart: false` is honored as an off-switch.
- `src/core/types.ts` — the three new optional fields on `monitoring.systemReview`.
- `tests/unit/SystemReviewer.test.ts` — 4 new tests (no-prior→runs, stale→runs, fresh→skips, reviewOnStart:false→never).

## Side effects & risk

- **Cost: one extra review per boot, only when stale.** The probes are LOCAL checks (no LLM, no network — verified by reading the probe sources), so a review is cheap. The freshness guard means even a rapid restart loop triggers at most one review per `initialReviewStaleAfterMs` window, not one per boot.
- **Boot is not slowed.** The review is on a 30s `setTimeout`, unref'd, and `review()` is already async — it never blocks startup.
- **Default-on, with an off-switch.** `monitoring.systemReview.reviewOnStart: false` disables it. Existing agents get the default (true) via the constructor's DEFAULT config — no migration needed (a code-side default, not a persisted-config requirement).
- **Failure is contained.** An on-boot review error goes to the existing dead-letter path (the same `writeDeadLetter` the interval uses), independent of DegradationReporter by design.
- **Risk:** low. Additive timer on a self-scheduling monitor; reversible (flag or revert); covered by tests.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** Each machine runs its own SystemReviewer over its own probes and persists to its own `review-history.jsonl`; the `/health` systemReview reflects THIS machine's health. The on-boot review is per-machine local behavior — no cross-machine state, no notice emitted, no URL generated. A pool already surfaces each machine's health via that machine's own `/health`.

## Verification

- `tsc --noEmit`: 0 errors.
- `tests/unit/SystemReviewer.test.ts`: 128/128 (124 existing + 4 new on-start tests covering both sides of the staleness boundary).

## Rollout

No migration. Default-on (the stale panel is a clear bug); off-switch via `monitoring.systemReview.reviewOnStart: false`.
