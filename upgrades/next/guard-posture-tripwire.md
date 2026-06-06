---
bump: patch
---

## What Changed

GuardPostureTripwire — "a disabled guard is itself an incident." Born from
2026-06-05, when the morning meltdown load-shed batch-flipped FIVE guards off
in config.json (scheduler, contextWedgeSentinel, failureLearning,
resourceLedger, burnDetection) and only the scheduler was noticed: the wedge
sentinel stayed dark and watched a session die for an hour that same evening
with zero audit rows. No instar code writes those flags — emergency hand-edits
leave no trace, so each dark guard was discoverable only by a user-facing
failure.

Now: at every server boot, the resolved guard posture (every `monitoring.*`
enabled flag + `scheduler.enabled` — generic by convention, no per-guard
registration) is compared against the persisted posture from the previous
boot. Any enabled→disabled transition gets a loud boot log line, one
aggregated row in `logs/guard-posture.jsonl`, and ONE aggregated HIGH
Attention item listing every newly-disabled guard. Re-enables get the
breadcrumb only. Signal-only: nothing is ever auto-re-enabled, a broken
tripwire can never break a boot, and the snapshot advances before alarms so
the same transition never re-alarms.

## What to Tell Your User

If any of my safety monitors ever gets switched off — by an emergency
intervention, a config edit, or anything else — you now hear about it at the
next restart instead of finding out weeks later when something it should have
caught hits you. One consolidated heads-up, with the history kept in a log
file. Nothing gets re-enabled behind your back; the heads-up is where you
decide.

## Summary of New Capabilities

- Boot-time guard-posture comparison with durable history at
  `logs/guard-posture.jsonl` and snapshot at `state/guard-posture.json`.
  Default-on, zero configuration; covers any future guard that follows the
  `monitoring.<key>.enabled` convention automatically.
- ONE aggregated HIGH Attention item per boot that saw disables (Bounded
  Notification Surface — never per-guard items).
- CLAUDE.md template + migration: agents are taught to check
  `logs/guard-posture.jsonl` FIRST when asked "why didn't the watchdog catch
  X?" — a silently-disabled guard explains more incidents than a broken one.

## Evidence

Incident grounding: last sentinel-enabled boot 21:54Z = the exact minute of
the #882 load-shed; 3 more dark guards found by config audit and re-enabled.
Unit: 12 tests incl. the verbatim 5-guard incident config → exactly ONE
aggregated item, no-repeat-alarm across boots, re-enable breadcrumb-only,
corrupt-snapshot self-repair, emit-failure baseline-advance. Migrator: 2
(added + idempotent). E2E: two-boot lifecycle over real disk + WIRED source
guard. tsc clean; preflight PASS.
