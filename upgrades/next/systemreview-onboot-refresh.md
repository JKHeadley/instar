## What Changed

The built-in "system review" (a batch of ~16 local self-checks surfaced in `/health` and rendered as the dashboard health panel) runs on a 6-hour timer — but it only ever ran when that timer fired, never on boot. Each restart resets the 6-hour timer, so on an agent that restarts more often than every 6 hours (updates, recovery bounces), the review never runs again after the first time, and the health panel freezes on a days-old snapshot. `SystemReviewer.start()` now also runs one review shortly after boot (default 30s delay, in the background, behind a default-on `reviewOnStart` flag), gated by a freshness guard so a restart loop doesn't pile up reviews (skipped if a review ran in the last hour; an unparseable timestamp errs toward running it).

## Evidence

Observed live on Echo: `curl /health` returned `systemReview` with `lastReview.timestamp = "2026-06-20T11:51:54.985Z"` and `status: "critical", passed: 11, failed: 5` — days stale, from a past incident, while the box was healthy (uptime ~1–2h, no current failures). Root cause confirmed by reading `start()`: it set the `scheduleMs` (6h) interval but ran no review on boot, and the probe sources contain no LLM/network calls (so an on-boot review is cheap). After: 4 new unit tests prove `start()` runs a review after the delay when the last review is absent or >1h old, and skips it when the last review is <1h old.

## What to Tell Your User

If your dashboard's health panel showed a scary days-old "critical" status even though everything was fine, that's fixed — the panel now refreshes within about 30 seconds of every startup, so it reflects current health instead of an old snapshot. There's nothing to do; it's on by default. If you'd ever prefer it only refresh on its slower six-hour cycle, just ask me and I'll switch it.

## Summary of New Capabilities

- `SystemReviewer` runs one review shortly after `start()` (in addition to the `scheduleMs` interval), so the health panel stays current on agents that restart more often than the interval.
- New `monitoring.systemReview` config: `reviewOnStart` (default true), `initialReviewDelayMs` (default 30s), `initialReviewStaleAfterMs` (default 1h — skip the on-boot review if the last one is younger than this).
