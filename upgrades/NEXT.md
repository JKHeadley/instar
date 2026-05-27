# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Notify-on-stop, Layer A: when an autonomous run reaches a terminal exit — it completed, ran out of its time budget, or was emergency-stopped — the agent now sends one plain-English Telegram to the run's topic explaining why it stopped. Previously these reasons were only written to stderr (the terminal the user can't see), so an autonomous run could end in silence unless the agent remembered to send a wrap-up. This bakes the "a session either keeps going OR tells you why it stopped" guarantee into the stop hook itself.

The notice is best-effort and non-blocking (a delivery hiccup never blocks the exit), fires at most once per run, and reuses the existing Telegram reply transport + the run's existing topic (no new topic is ever created).

Existing agents receive the notify-enabled hook automatically: the autonomous-stop-hook capability marker is bumped, so the marker+fingerprint migration re-deploys the updated hook to stock installs on update (customized hooks are left untouched).

## What to Tell Your User

- When one of my autonomous runs finishes (or times out, or is stopped), you now get a short heads-up explaining why — no more silent endings.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Autonomous-run terminal exits send a Telegram explaining why | Automatic; one message per run to the run's topic |

## Evidence

- Hook: `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` (`notify_terminal_stop` at all 6 terminal exits).
- Migration: `src/core/PostUpdateMigrator.ts` (capability marker → `notify_terminal_stop`).
- Tests: `tests/unit/autonomous-stop-hook-notify.test.ts` (9 — static wiring, functional delivery via the real extracted helper, migration).
- Spec: `docs/specs/NOTIFY-ON-STOP-SPEC.md` (approved) + `.eli16.md`. Side-effects: `upgrades/side-effects/notify-on-stop-layer-a.md`.
- Layer B (watchdog-caught mid-task stalls) ships separately under the same spec.
