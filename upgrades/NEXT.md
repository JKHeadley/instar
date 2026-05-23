# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Stops the silently-stopped-sentinel topic-spam flood (incident 2026-05-22, where a server restart produced ~14 "X went quiet" Telegram topics in a couple of minutes because old, leftover tmux sessions whose frozen last frames still said "esc to interrupt" were misread as "was working, then stopped"). Three independent defects, all fixed together.

**The detection no longer believes the frame, it believes the change.** The watchdog used to mark a session "was producing output" the very first time it saw it — so on a fresh server restart, every leftover tmux session looked like it had just produced output and then stopped. Now the watchdog only counts a session as silence-eligible after it has actually *watched* its output change at least once. A session that was already frozen before the server started watching can never trip the alert.

**Routine monitoring goes to the logs, not your phone.** A new `SentinelNotifier` now sits between the two silently-stopped sentinels and any user-facing notification. Every detection / nudge / recovery transition is written to `logs/server.log` and a structured audit trail at `logs/sentinel-events.jsonl` — and that's it. Telegram is off by default. If you want a heads-up when something genuinely freezes and the nudge doesn't bring it back, set `monitoring.sentinelTelegramEscalation: true` in `.instar/config.json`. Even then, you get ONE consolidated message coalescing every affected session in the existing system (lifeline) topic — never a brand-new topic per event.

**No flapping during a restart burst.** If multiple sessions cross the silence threshold within seconds of each other, they're folded into a single "N background sessions were working and went quiet, want me to dig in?" message in the system topic, not N separate Telegram topics with /ack /done buttons.

## What to Tell Your User

- The watchdog will no longer flag long-dead tmux sessions as "stuck" after a server restart — the noise stops at the source.
- By default, sentinel events are housekeeping and stay in the logs. You won't see Telegram messages for them.
- If you ever DO want a heads-up when a real session freezes mid-task, just ask your agent to turn on Telegram heads-ups for sentinel events. You'll get one consolidated message in the existing system topic, never new topics.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Observed-change detection | Automatic. A session is silence-eligible only after the watchdog watches its output change at least once. Frozen-since-before-restart sessions can never trip the alert. |
| Sentinel audit trail | Automatic. Every transition is logged to `logs/server.log` and `logs/sentinel-events.jsonl`. |
| Default-silent escalation | Automatic. `monitoring.sentinelTelegramEscalation` defaults to false → no Telegram messages from sentinel monitoring. |
| Opt-in consolidated heads-up | Set `monitoring.sentinelTelegramEscalation: true` → genuine recovery-failed escalations coalesce into ONE message in the existing system topic. No new-topic-per-event. |

## Evidence

- Detection fix: `src/monitoring/sentinelWiring.ts` (OutputActivityTracker). Tests in `tests/unit/monitoring/sentinelWiring.test.ts` — three explicit guards (first sighting → lastOutputAt 0, frozen-never-changed stays at 0 for 30 ticks, only an observed change advances the stamp).
- Routing + severity fix: new `src/monitoring/SentinelNotifier.ts` (11 unit tests in `tests/unit/monitoring/SentinelNotifier.test.ts`) — covers both sides of every boundary (log-only default, opt-in coalesced send, dedupe, send failure path, throwing log sink).
- Integration: `tests/integration/silently-stopped-trio-wiring.test.ts` — drives the full sentinel + notifier pipeline through the 2026-05-22 flood scenario; the dead leftover sessions never escalate.
- E2E lifecycle: `tests/e2e/silently-stopped-sentinel-lifecycle.test.ts` — boots the production assembly against a tmp stateDir, reads the JSONL audit file the server would have written, and asserts default-off behavior + opt-in coalesced delivery.

## Migration

Automatic for existing agents on update — the new `monitoring.sentinelTelegramEscalation: false` default lands via the ConfigDefaults registry + `applyDefaults()` in `PostUpdateMigrator.migrateConfig`. A `Sentinel Notifications (silently-stopped trio)` section is appended to `CLAUDE.md` by `PostUpdateMigrator.migrateClaudeMd` so the agent knows where sentinel events go and how to opt into Telegram heads-ups. Both migrations are idempotent.

## Rollback

Behavioral: set `monitoring.sentinelTelegramEscalation: true` in `.instar/config.json` to restore Telegram heads-ups (still consolidated, no flood). The pre-2026-05-22 topic-per-event behavior is intentionally not restorable — it was the bug.

Code: revert this commit; `buildXDeps` reverts to taking `notify: AttentionPoster` and `server.ts` reverts to `makeAttentionPoster`. The detection fix in `OutputActivityTracker` is independent and may be left in place even if the routing change is reverted.
