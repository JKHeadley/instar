# Side-Effects Review — feat(memory): periodic SessionActivitySentinel scan

**Branch:** `echo/phase-0b-periodic-scan`
**Origin:** Phase 0b of the topic-intent-layer thread (Telegram 9976). Last foundation piece before Phase 1.

## Summary

Wires the periodic `SessionActivitySentinel.scan()` (every 30 min default) as a `setInterval` in `server.ts`, gated to the awake machine. Previously the sentinel only fired on `sessionComplete`, so long-running sessions never got mid-flight digestion and the Phase 0d entity extraction never ran for them.

## Files touched

- `src/core/types.ts` — added optional `MonitoringConfig.episodicSentinel` ({ enabled?, scanIntervalMinutes? }).
- `src/monitoring/SessionActivitySentinel.ts` — added pure helper `resolveSentinelScanIntervalMs`.
- `src/commands/server.ts` — wired the periodic scan interval after the sessionComplete handler; imports the new helper.
- `tests/unit/sentinel-scan-interval.test.ts` — 6 tests on the resolver.
- `docs/specs/periodic-sentinel-scan.md` + `.eli16.md` — spec + ELI16.
- `upgrades/NEXT.md` — release note.

## Over-block check

The scan only runs when `resolveSentinelScanIntervalMs` returns non-null (enabled !== false) AND (no coordinator OR the machine is awake). It does NOT run on standby machines. It does NOT add an immediate startup scan (first fire is one interval out), so restart loops don't trigger repeated digestion. No new behaviour in the disabled path — `enabled: false` returns null and no interval is created.

## Under-block check

Could a long session still be missed? Only if: the periodic scan is disabled by config AND the session never reaches sessionComplete. That's an explicit operator opt-out, not a silent gap. The default (on, 30 min) covers the case the spec targets.

scan() itself enforces dormant-skip and minimum-activity internally, so an idle session that the timer visits costs nothing — no over-digestion of quiet sessions.

## Level-of-abstraction fit

The interval policy (default, floor, disabled) is a pure function on the sentinel module — testable in isolation, no server bootstrap needed. The actual `setInterval` lives in server.ts next to the existing sessionComplete wire and the other periodic timers (relayPrune, resumeHeartbeat), matching the established in-process-timer pattern. The sentinel class is unchanged — it already had scan(); we just call it on a cadence.

## Signal-vs-authority compliance

Not a gate — this is a scheduler wire, not a filter. The closest principle is the awake-machine gating: the coordinator (authority on which machine is active) decides whether this machine scans. The timer defers to `coordinator.isAwake` rather than making its own liveness call.

## Interactions

- **sessionComplete synthesis**: unchanged. The periodic scan and the completion synthesis are independent; scan()'s idempotency (hash-keyed digests) means a periodic scan immediately before sessionComplete won't double-digest the same activity window.
- **scan() idempotency / dormant-skip / min-activity**: relied upon, unchanged. These guards are what make a 30-min cadence safe.
- **SemanticMemory entity extraction (Phase 0d)**: this scan is what drives it mid-session. The two compose: scan → digestUnit → materializeEntities. No new coupling; the periodic scan just calls the same digestActivity path the sessionComplete handler already used.
- **Multi-machine coordinator**: awake-gating added; mirrors `config.scheduler.enabled && coordinator.isAwake`. Standby machines skip.
- **Scheduler / jobs.json**: untouched. This is an in-process timer, not a cron job, so it doesn't interact with quota-tracked job scheduling. (Note: the LLM spend of periodic digestion is NOT currently quota-gated the way scheduled jobs are — see follow-up.)

## Telemetry / observability

- A `console.log` fires on startup naming the cadence ("periodic scan every 30min").
- Each scan that creates digests logs the count.
- Failures log via console.error, never throw.
- `SemanticMemory.stats()` entity/edge growth is the downstream signal that the pipeline is working end-to-end.

## Rollback

Single-commit revert removes the interval, the config field, and the helper. Reverts to sessionComplete-only — the pre-change behaviour. No data/config migration (the field is optional and absent by default).

## Cross-framework portability (v1.0+)

Framework-agnostic: the scan reads tmux capture + Telegram JSONL and digests via `sharedIntelligence`. No INSTAR_FRAMEWORK branching. Same cadence on Claude and Codex.

## Follow-ups (tracked, not orphaned)

1. **Quota-awareness for periodic digestion LLM spend.** Scheduled jobs route through QuotaTracker; this in-process timer does not. On a quota-constrained agent, periodic digestion competes with foreground work for the same budget. A future enhancement could check `quotaTracker.canRunJob` before each scan. Lower priority — digestion uses the cheap `fast` tier and dormant-skip keeps volume low.
2. **Live runtime verification.** The spec's acceptance includes a manual live check (set 5-min cadence, send messages, confirm a digest appears mid-session). Requires a live multi-message session; noted for the next live-agent session.

Both tracked as initiatives, intentionally out of scope here.
