# Side-Effects Review — DeliveryFailureSentinel startup tick

**Version / slug:** `sentinel-immediate-first-tick`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

start() runs one awaited tick() after arming the watchdog (and after the existing one-shot restore-purge and event-listener registration). The tick is the same code path the watchdog and delivery_failed events already invoke; its own try/catch contains failures (logged, start() still completes).

## Decision-point inventory

- start() — modified — awaited first drain; 'sentinel:started' now emitted AFTER the initial drain completes.
- tick(), watchdog cadence, event kicks, per-topic rate limit, backoff, stampede digest, purge — untouched.

## Direction of failure

- Old: recovery waited ≥5 min after every boot; under restart cascades (up-window < boot + 5 min) the queue never drained — live 70+ min user-facing outage of QUEUED (safe but stuck) messages.
- New: backlog drains at boot. A failing startup tick logs and start() completes — degraded to exactly the old behavior (watchdog picks it up).
- Conservative direction: messages deliver sooner; nothing new is dropped or retried beyond existing budgets.

## Side-effects checklist

1. **Boot latency:** start() now includes one drain pass. Per-delivery I/O is already bounded (postReply timeouts); a large backlog is paced by the existing per-topic rate limit — residual items wait for the watchdog exactly as before. Boot-blocking risk bounded by the same budgets every tick obeys.
2. **Ordering with restore-purge:** unchanged — purge (one-shot) still precedes the first drain, so the startup tick never delivers rows the purge policy retires.
3. **Double-tick race:** the in-flight/lease machinery already serializes concurrent ticks (watchdog + event kicks coexist today); the startup tick is just one more entrant.
4. **Test contract change:** "start() then explicit tick()" tests now see the backlog consumed by start — the recovery happy path was re-pinned to assert the NEW contract explicitly (start drains; next tick returns 0).
5. **External surfaces:** none — no routes/config/schema.
6. **Rollback cost:** revert the commit.

## Scope not taken

- No watchdog-interval retune (5 min stays right for steady state).
- No restart-cascade dampener changes (separate system; its own review queued from today's observations).

## Rollback

Revert. Recovery returns to first-drain-at-+5min.
