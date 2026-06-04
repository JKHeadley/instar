# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The Parallel-Work overlap councilor can now actually run.** The previous change shipped the
detector and the sentinel as tested library code; this wires the `ParallelWorkSentinel` into
the server so it ticks on a cadence over the cross-topic activity index, spots when two of
your topics are working on the same thing, and nudges you once — with a cooldown so it never
re-nags. It is signal-only and never gates.

It ships **dark**: off by default behind `monitoring.parallelWorkSentinel.enabled`. A
false-positive nudge is worse than silence, so it graduates only after it is shown to be
quiet. When on, it scans every ~15 minutes, audits every transition to
`logs/sentinel-events.jsonl`, and the timer is unref'd + cleaned up on shutdown.

## What to Tell Your User

Optional: if your agent works across many topics and you want it to proactively notice when
two topics are doing the same work, you can turn on the overlap councilor in your monitoring
config. It is off by default and only ever sends a gentle heads-up -- it never blocks anything.

## Summary of New Capabilities

- `monitoring.parallelWorkSentinel.enabled` (default false, ships dark) +
  `cadenceMinutes` (default 15) — turns on and tunes the proactive overlap councilor.
- The `ParallelWorkSentinel` is now constructed + cadenced in the server when enabled, with
  every transition audited to `logs/sentinel-events.jsonl`.

## Evidence

- Wiring-integrity test (Testing Integrity Standard): boots the real AgentServer and asserts
  the sentinel is NOT constructed when the flag is off (ships dark) and IS constructed +
  ticks when the flag is on. tsc clean.
- The detector + sentinel logic is already covered by 17 unit tests (shipped with the
  prior change); this change only turns them on.
