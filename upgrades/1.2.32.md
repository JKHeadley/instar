# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new agent-facing capability without breaking changes -->

## What Changed

**feat(memory): periodic activity-digest scan — digest long-running sessions mid-flight.**

The activity-digest entity-extraction pipeline (shipped just prior) only ran when a session reached `sessionComplete`. For a long-running Telegram topic that runs for hours or days, or never cleanly ends (compaction, machine restart, watchdog kill), that meant the activity was never digested mid-flight and the entities within it never reached SemanticMemory. The knowledge graph stayed sparse precisely for the longest, most context-rich topics — the exact shape this memory effort is meant to serve.

This release wires the periodic `SessionActivitySentinel.scan()` (which already existed but was never scheduled) as an in-process timer. By default it runs every 30 minutes, digesting in-progress sessions that have accumulated new activity. Combined with the entity extraction, the knowledge graph now grows throughout a long session, not only at its end.

Details:

1. New optional config `monitoring.episodicSentinel` with `enabled` (default true) and `scanIntervalMinutes` (default 30, floored at 5). Absent by default — existing agents get the 30-minute scan automatically.

2. A new pure helper `resolveSentinelScanIntervalMs` computes the effective interval (default / floor / disabled), unit-tested independently of the server bootstrap.

3. The scan timer is gated to the awake machine in a multi-machine setup (mirrors the scheduler gating), so standby machines don't double-digest. It `unref()`s so it never blocks process exit, and a failing scan is logged, never thrown.

4. `scan()` itself is unchanged — it already enforces idempotency (hash-keyed digests), dormant-session skipping, and a minimum-activity threshold, so a 30-minute cadence is safe and idle sessions cost nothing.

## Evidence

6 new unit tests on the interval resolver (`tests/unit/sentinel-scan-interval.test.ts`): default 30 minutes, null when disabled, custom interval, 5-minute floor-clamp (at 1/0/negative), exact-floor. The 21 existing `session-activity-sentinel.test.ts` tests and 7 `SessionActivitySentinel-entity-extraction.test.ts` tests still pass — confirming `scan()` behaviour is unchanged. The wiring is in-process `setInterval` following the established relay-prune / resume-heartbeat timer pattern; `tsc --noEmit` clean.

## What to Tell Your User

Your agent now keeps its memory current during long conversations, not just when they end. Every half hour it quietly reviews in-progress conversations that have new activity and files away the important facts. For a conversation that runs for days, this means the agent stays aware of decisions and facts from earlier in the same conversation instead of only catching up at the very end. It's on by default and costs nothing for idle conversations.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Periodic mid-session activity digestion | Automatic — every 30 min (configurable via `monitoring.episodicSentinel.scanIntervalMinutes`) |
| Disable / retune the cadence | Set `monitoring.episodicSentinel.enabled` false, or `scanIntervalMinutes` (floored at 5) |
