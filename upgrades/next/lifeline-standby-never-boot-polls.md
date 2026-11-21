# Standby machines leave Telegram alone while starting

## What Changed

A standby's observe-only or mute setting now applies from the beginning of its Telegram supervisor startup. Ordinary coordinated starts need positive lease intent. Unmuted roles retain the original three-minute emergency fallback so /restart works even if the server cannot boot; observe-only/mute roles never use it, and fresh standby intent cancels it. Single-machine agents and independent mode retain their existing startup behavior. A watchdog recovery for a Telegram conflict leaves the healthy agent server running. Forward-failure recovery still restarts the server when needed. Lifeline exits are recorded with an observed server outcome; unknown is never reported as a confirmed restart.

## What to Tell Your User

If a standby machine starts slowly, it no longer briefly competes with the lead machine for Telegram messages. Recovering a Telegram connection conflict also leaves the lead server and its work running.

## Summary of New Capabilities

None — this repairs existing multi-machine startup and recovery.

## Evidence

The emergency-availability correction passed the poll-decision/startup unit checks and all 19 startup/server-adoption lifecycle tests, including an actual /restart command when the server cannot boot. Typecheck passed. The earlier unchanged HTTP outcome tests passed all 10 cases. Full suite remains pending for this corrected candidate. The lifecycle checks preserve the real server pane process across a conflict watchdog recovery and successor adoption. The full test suite remains a shared Local Verify release gate; no live deployment is claimed by this change.
