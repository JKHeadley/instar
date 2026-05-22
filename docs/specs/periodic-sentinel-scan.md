---
title: "Periodic SessionActivitySentinel scan — digest long-running sessions mid-flight"
slug: "periodic-sentinel-scan"
author: "echo"
review-convergence: "single-iteration"
review-iterations: 1
convergence-note: "Retrospective single-iteration convergence: mechanically narrow (one config field + one setInterval wire + one extracted pure helper), rollback is a single revert that returns the sessionComplete-only behaviour, and scan() already ships with idempotency / dormant-skip / minimum-activity guards so the cadence cannot misbehave. Lower-risk than the 5-iteration target — same standard applied to the Initiative Tracker (2026-04-18), heal-execpath-staleness (2026-05-21), and activity-digest-entity-extraction (2026-05-22) specs."
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-22"
approval-note: "Approved via Telegram topic 9976 (topic-intent-layer): 'I agree with all recommendations. Please proceed' (2026-05-21, covering the Phase 0 sequencing including 0b) and 'please enter autonomous mode and continue through' (2026-05-22, authorizing autonomous execution of the remaining Phase 0 + Phase 1 work). Phase 0b — wiring the periodic sentinel scan — is the last foundation piece before Phase 1."
---

# Periodic SessionActivitySentinel scan

## ELI10 version

The agent already writes short summaries of its work and pulls durable facts out of them into its memory graph. But until now it only did this when a conversation FINISHED. Long conversations that run for hours or days — or never cleanly end because of a restart — never got summarized, so all that work never reached the memory graph.

This change makes the agent summarize in-progress conversations on a timer (every 30 minutes by default). Now the memory graph grows throughout a long conversation, not just at the end.

## Problem

`SessionActivitySentinel` digests session activity into mini-digests and (since Phase 0d) extracts typed entities from those digests into SemanticMemory. But the only trigger wired in `server.ts` was the `sessionComplete` event → `synthesizeSession`. The periodic `scan()` method — which PROP-memory-architecture Phase 3 specifies should run "every 30-60 min" — existed but was never scheduled.

Consequence: a long-running Telegram topic (the exact shape of the GCI case that started this whole thread — 326 messages over two months) accumulates hours of activity that is never digested mid-flight. The entity-extraction pipeline shipped in Phase 0d only fires at `sessionComplete`, which for a long-lived interactive topic may be days away or may never happen cleanly (compaction, machine restart, watchdog kill). The knowledge graph the Topic Intent Layer will read from stays sparse precisely for the topics that need it most.

## Solution

Wire a periodic in-process scan interval next to the existing `sessionComplete` handler in `server.ts`.

### Interval resolution

A new pure helper `resolveSentinelScanIntervalMs(cfg)` in `SessionActivitySentinel.ts`:

- Returns `null` when `cfg.enabled === false` (periodic scan disabled; sessionComplete synthesis still runs).
- Otherwise returns `max(5, cfg.scanIntervalMinutes ?? 30) * 60_000`.
- 30-minute default; 5-minute floor (a faster cadence wastes LLM budget — `scan()` skips dormant sessions and enforces a minimum-activity threshold internally, so there's no value scanning more often).

Extracted as a pure function so the clamp / default / disabled policy is unit-testable without standing up the full server bootstrap.

### Config

New optional `MonitoringConfig.episodicSentinel`:

```
episodicSentinel?: {
  enabled?: boolean;            // default true
  scanIntervalMinutes?: number; // default 30, floored at 5
}
```

Optional and absent by default — existing agents get the 30-minute scan automatically (default-on), matching the Phase 0 decision to default-on memory-graph population. Operators who want it off set `enabled: false`.

### Wiring

In `server.ts`, after the `sessionComplete` synthesis handler:

```
const scanIntervalMs = resolveSentinelScanIntervalMs(config.monitoring.episodicSentinel);
if (scanIntervalMs !== null) {
  const activityScanTimer = setInterval(() => {
    if (coordinator.enabled && !coordinator.isAwake) return; // awake-machine only
    activitySentinel.scan().then(...).catch(...);
  }, scanIntervalMs);
  if (activityScanTimer.unref) activityScanTimer.unref();
}
```

- `unref()` so the timer never blocks process exit.
- Awake-machine gating mirrors the scheduler gating (`config.scheduler.enabled && coordinator.isAwake`) so a standby machine in a multi-machine setup doesn't double-digest the same sessions.
- Errors are caught and logged, never thrown — a failing scan must not crash the server.

## Decision-point inventory

1. **In-process setInterval vs cron job.** `scan()` is an in-process LLM operation against live session state (tmux capture + Telegram log), not an agent-prompt job. The `setInterval` + `unref` pattern (used by relayPruneTimer, resumeHeartbeat) is the right analog, not the jobs.json cron pattern (used by memory-hygiene, which spawns an agent session). Chose setInterval.

2. **Default cadence.** 30 min. PROP-memory-architecture says "30-60 min." 30 captures more granular activity boundaries; the dormant-skip + min-activity guards mean idle sessions cost nothing. Operators can widen via config.

3. **Default on vs off.** On. Matches the Phase 0 graph-population decision. The whole point of Phase 0 is to stop the graph being empty; shipping the scan disabled-by-default would defeat that.

4. **Awake-machine gating.** Required. Without it, every machine in a multi-machine setup scans the same sessions, double-spending LLM budget and racing on digest writes (idempotency would dedup the writes, but the LLM spend is wasted). Gate mirrors the scheduler.

5. **Initial immediate scan on startup?** No. The first scan fires after one interval. An immediate scan on every restart would re-digest recently-active sessions on restart loops. The interval delay is the safer default; sessions accumulate activity by the first tick.

## Tests

`tests/unit/sentinel-scan-interval.test.ts` — 6 tests on the resolver:
- default 30 min (no config / empty config)
- null when disabled (and disabled overrides a set interval)
- enabled:true / enabled:undefined both on
- honors custom interval
- clamps below the 5-min floor (1, 0, negative)
- allows exactly the floor

The 21 existing `session-activity-sentinel.test.ts` and 7 `SessionActivitySentinel-entity-extraction.test.ts` tests confirm `scan()` itself (idempotency, dormant-skip, digest creation, entity extraction) is unchanged.

## Acceptance evidence

Per the bug-fix-evidence memory: the failure mode is "long sessions never get mid-flight digests." Pre-change, `grep` of `server.ts` shows the only `activitySentinel` trigger is `sessionComplete`. Post-change, the periodic interval is wired and gated. The resolver tests verify the cadence policy; the existing sentinel tests verify scan() does the right thing when called. Together: the scan now runs on a cadence AND does the right thing each time.

Live verification (manual, post-merge): set `scanIntervalMinutes: 5` on a test agent, start a session, send 10+ messages, wait one interval, confirm a digest appears and (with SemanticMemory wired) entity count rises — without ending the session. This is a runtime check the autonomous run notes for follow-up since it requires a live multi-message session.

## Cross-framework portability (v1.0+)

The scan path is framework-agnostic: it reads tmux capture + Telegram JSONL and calls the framework-aware `sharedIntelligence` for digestion. No `INSTAR_FRAMEWORK` branching. Codex agents with a different session-output shape see the same cadence; extraction quality varies with output shape but the wiring is identical.

## Rollback

Single-commit revert removes the interval wire, the config field, and the helper. Reverts to sessionComplete-only digestion — the pre-change behaviour, not a worse state. No data migration; no config migration (the field is optional and absent by default).

## Out of scope (intentional)

- Adaptive cadence (scan more often when sessions are active, less when idle). The dormant-skip already makes idle scans cheap; adaptive timing is a future optimization.
- Backfilling digests for sessions that ran before this shipped. Those are captured at their sessionComplete (or already missed); no retroactive scan.

## Origin

Topic 9976 (topic-intent-layer), 2026-05-22. Phase 0b — the last foundation piece. Phase 0a's investigation found the periodic scan unwired; Phase 0d shipped the entity extraction that this scan now drives mid-session. Together they make the knowledge graph grow throughout long sessions, which is the prerequisite for the Topic Intent Layer (Phase 1) to have a populated graph to read from.
