---
bump: patch
---

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

## What to Tell Your User

Only relevant if I run on more than one machine: when the standby machine's
copy of a conversation falls behind for over half an hour (because syncs to it
keep failing), that fact is now recorded in my health/degradation log instead
of being invisible. Nothing pings you — but if a machine takeover ever resumes
a conversation from an older point, there's now a checkable record explaining
exactly which conversation was behind and since when.

## Summary of New Capabilities

- Stale-standby visibility: one degradation record per conversation per outage
  when cross-machine sync has been failing ≥30min (`LiveTail.standbyFreshness`
  in the degradation log / Process Health surfaces); retries continue
  unchanged. No configuration needed.

## Evidence

Gap noted by #867's own second-pass reviewer ("backoff but no breaker") and
resolved per the ratified Eternal Sentinel clause: persistence kept, silence
removed. Focused adversarial second-pass: CONCUR (episode timing, firing bound
= threshold + one backoff window, recordNoNewContent edge traced safe,
DegradationReporter flood analysis). Tests: 21 green in LiveTailSource.test.ts
incl. the P19 sustained-failure bound (~100 failing windows → exactly 1
signal) and the server.ts wiring pin; tsc clean.
