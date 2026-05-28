# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Phase 3 of the unified session-lifecycle robustness work (spec
`docs/specs/unified-session-lifecycle-robustness.md`) — the last two items.**
With Phase 1 and Phase 2 already on main, this completes the converged design:
every autonomous killer shares the same brain, and the small UX bonus you
asked for is in.

What landed:

- **#7 quota soft-check (bounded).** The quota-driven session migrator (the
  thing that halts running sessions to switch accounts when you're running out
  of weekly/5-hour budget) used to send Ctrl+C, wait `gracePeriodMs`, and then
  force-kill anyone still alive. Now: when current usage is at or below a
  configurable ceiling (`softCheckMaxUsagePercent`, default 95%), an
  active build or autonomous run gets ONE extra Ctrl+C grace round before
  force-kill. ABOVE the ceiling the soft check is **disabled** so quota's
  final authority is never undermined; if current usage can't be read,
  it's treated as 100% (fail-closed — no grace without proof we're below
  the ceiling). The force-kill itself now goes through the single
  ReapAuthority (`terminateSession('quota-shed', terminal/killed)`) so the
  "your session was shut down" notice fires + the reap-log records the
  `quota-shed` reason. A new structured `quota-force-kill-decision` event
  publishes the inputs for a future Tier-1 supervisor.
- **Bonus — session label follows topic rename.** When you rename a Telegram
  forum topic, the bound session's display `name` updates to match. The
  operational identity (`tmuxSession` key + `id` UUID) is never touched —
  every internal lookup keeps working. The handler fires ONLY on a true
  rename event (`forum_topic_edited`), not on initial-capture or topic
  creation. The renamed value flows through the same §P3 sanitization
  (literal code spans) wherever it surfaces in user-facing notices, so a
  malicious name can't inject markup.

This closes the spec's Phase 3 scope. After this, all eight autonomous
killers (boot purge, age-kill, idle-zombie, watchdog, orphan reaper,
SessionRecovery, wake-reaper, quota-shed) share the same authority + KEEP-
guard + lease gate + reap-log + sessionReaped event.

## What to Tell Your User

- When you're running low on hours, the quota cleanup is gentler: a
  session that's actively building or running an autonomous task gets one
  more polite Ctrl+C before being shut down — unless we're already very
  near the limit, in which case quota's final authority still kicks in
  immediately. Either way, the shutdown shows up in the reap-log with the
  reason.
- When you rename a Telegram topic, the session label updates to match
  what you renamed it. The agent's plumbing keeps working — only the
  display name changes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded quota soft-check (one extra Ctrl+C grace for working sessions) | Automatic. Tunable via `monitoring.sessionMigration.thresholds.softCheckEnabled` / `softCheckMaxUsagePercent` (default 95) / `softCheckExtraGraceMs` (default = `gracePeriodMs`). |
| Quota force-kill via ReapAuthority + `quota-force-kill-decision` event | Automatic — surfaces "your session was shut down — quota-shed" + lands in the reap-log; a future Tier-1 LLM supervisor can subscribe to the decision event. |
| Session label follows Telegram topic rename | Automatic — rename a forum topic, the bound session's display name follows. |

## Evidence

- Unit: SessionManager rename (5) + Phase-3 wiring (9) green; SessionMigrator
  existing (37) still passes; SessionWatchdog (58), OrphanProcessReaper (9),
  SessionRecovery (9), terminate-CAS (9), JobScheduler reaper (7),
  SleepWakeDetector cumulative (6) — all still green.
- `tsc --noEmit` clean.
- Side-effects review updated per-commit:
  `upgrades/side-effects/unified-session-lifecycle-robustness.md`.
