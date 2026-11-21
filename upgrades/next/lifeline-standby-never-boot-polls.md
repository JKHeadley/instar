# Standby machines leave Telegram alone while starting

## What Changed

A standby's observe-only or mute setting now applies from the beginning of its Telegram supervisor startup. A slow coordinated boot waits for a real positive lease intent, even after its old three-minute deadline. Single-machine agents and independent mode retain their existing startup behavior. A watchdog recovery for a Telegram conflict leaves the healthy agent server running. Forward-failure recovery still restarts the server when needed. Lifeline exits are recorded with an observed server outcome; unknown is never reported as a confirmed restart.

## What to Tell Your User

If a standby machine starts slowly, it no longer briefly competes with the lead machine for Telegram messages. Recovering a Telegram connection conflict also leaves the lead server and its work running.

## Summary of New Capabilities

None — this repairs existing multi-machine startup and recovery.

## Evidence

Targeted checks passed: 71 unit tests, 10 HTTP integration tests and 13 lifecycle tests; source typecheck passed. The lifecycle checks preserve the real server pane process across a conflict watchdog recovery and successor adoption. The full test suite remains a shared Local Verify release gate; no live deployment is claimed by this change.
