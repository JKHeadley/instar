---
bump: patch
---
<!-- internal-only -->

## What Changed

Audit fix #3 under "No Unbounded Loops" (P19, Eternal Sentinel condition 4):
the live-tail flusher's capped backoff (#867) correctly retries a failing topic
forever, but a topic whose standby copy went stale never said so. Now a
per-topic episode latch (the `SlowRetrySentinelEscalation` shape) fires once
per outage when flushes have failed ≥30min: one log line + one
`DegradationReporter` record (`LiveTail.standbyFreshness`, topic NAME included,
housekeeping channel — the reporter's per-feature 1h cooldown bounds even an
all-topics-stale storm to a single alert). Success clears the episode. The
`reportStaleStandby` dep is optional — omitted, behavior is byte-identical.

## Evidence

Gap noted by #867's own second-pass reviewer ("backoff but no breaker") and
resolved per the ratified Eternal Sentinel clause: persistence kept, silence
removed. Focused adversarial second-pass: CONCUR (episode timing, firing bound
= threshold + one backoff window, recordNoNewContent edge traced safe,
DegradationReporter flood analysis). Tests: 21 green in LiveTailSource.test.ts
incl. the P19 sustained-failure bound (~100 failing windows → exactly 1
signal) and the server.ts wiring pin; tsc clean.
