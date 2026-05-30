# Side-Effects Review — settled-throttle detection (RateLimitSentinel actually fires)

**Version / slug:** `throttle-settled-detection`
**Date:** `2026-05-30`
**Author:** `echo`
**Driving spec:** `docs/specs/rate-limit-sentinel.md` (§Settled-throttle detection — the live fix)
**Second-pass reviewer:** `not required` (single-author behavioral fix to an already-shipped sentinel; no new external surface)

## Summary of the change

The RateLimitSentinel (shipped PR #528, live at v1.3.108) was built, wired, and
enabled but fired **zero** times in the field — throttled sessions hung 5–10
minutes until the 15-minute silence fallback. Root cause was the detection
preconditions in `SessionWatchdog.checkRateLimited`, not the recovery machinery:
it required a session be "cleanly idle, no active child processes, at a prompt,
throttle string in the last 20 lines." Busy dev sessions never satisfy that —
they have a live background shell/MCP process, and Claude Code's input box pushes
the `API Error:` line out of the 20-line window.

The fix replaces those gates with a **settled-output signal**: throttle string in
a widened 45-line window + pane byte-identical across two consecutive watchdog
polls (an actively-working session animates its spinner/elapsed-timer every tick,
so a frozen pane is a reliable "turn ended, stuck" signal). No process-tree
inspection, no at-prompt heuristic. After a recovery cycle escalates and clears
(~30s), a still-stuck pane re-emits past the 60s cooldown → **unbounded retry**
until the throttle lifts (the "never hang forever" guarantee Justin asked for).

## Files touched

- `src/monitoring/rateLimitDetection.ts` — `detectRateLimited` gains an optional
  `captureLines` param (default 20, unchanged for existing callers); new
  `RATE_LIMIT_SETTLED_CAPTURE_LINES=45`, `RATE_LIMIT_DEFAULT_SETTLE_MS=20000`,
  `throttleSignature()`, and the pure clock-injected `evaluateThrottleSettle()`.
- `src/monitoring/SessionWatchdog.ts` — `checkRateLimited` rewritten to the
  settled-output decision; removed the active-child-process and at-prompt gates;
  added `throttleSettle` tracking map + `rateLimitSettleMs` (config-read).
- `src/core/types.ts` — `monitoring.watchdog.rateLimitSettleMs?: number`.
- `src/commands/server.ts` — wire RateLimitSentinel lifecycle events
  (detected/resuming/recovered/escalated) into `logs/sentinel-events.jsonl`.
- `tests/unit/rate-limit-detection.test.ts` — +16 cases (widened-window
  regression reproducing the incident; throttleSignature; evaluateThrottleSettle
  both sides of every branch).
- `tests/unit/SessionWatchdog-rate-limit-settle.test.ts` — new, 8 wiring cases.
- `upgrades/NEXT.md`, `docs/specs/rate-limit-sentinel.md` (+eli16) — docs.

## Decision-point inventory

- **Stuck-vs-working discriminator** — *modify*. Was process-tree + at-prompt +
  20-line window; is now byte-identical-pane across polls + 45-line window. Pure
  function (`evaluateThrottleSettle`), no judgment, fully unit-tested.
- **Widened capture window (45 lines)** — *new, bounded*. Only the watchdog
  settled path uses it; `detectRateLimited`'s default stays 20 for every other
  caller (SessionManager idle path unchanged). Old-throttle-scrolled-away and
  usage-limit/mid-retry exclusions still hold at 45 lines (tested).
- **Unbounded re-emit after escalation** — *behavioral, intentional*. Bounded by
  the 60s watchdog cooldown + the sentinel's own dedupe; the throttle is
  Anthropic's short-lived shared-capacity signal, so cycles are few in practice.
  This is the load-bearing "never hang forever" property.
- **Audit-log wiring** — *additive observability*. Best-effort `appendFileSync`
  to the existing sentinel-events.jsonl; annotated `@silent-fallback-ok` (never
  crashes the monitor path). No new route, no new external surface.
- **`rateLimitSettleMs` config** — *additive, back-compat*. Optional, code
  default 20000; configs without it are unaffected → no migration required.

## Blast radius / rollback

Pure monitoring-path change; no API routes, no schema, no state-file format
change. The `RateLimitSentinel.enabled` master switch (existing) disables the
whole path. Reverting this commit restores the prior gates verbatim. Existing
121 rate-limit/watchdog tests pass unchanged (event contract preserved).
