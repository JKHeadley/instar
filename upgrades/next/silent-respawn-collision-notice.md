# Silent respawn collision notice

## What Changed

When a Telegram message arrives while a dead session is already being respawned, Instar now tells the user that this particular message was not queued or delivered and asks them to resend it after the restart. This closes the remaining single-machine silent-loss path without adding another queue.

## What to Tell Your User

If a message collides with an in-progress session restart, you will now receive an honest resend instruction instead of waiting indefinitely for a message that was never accepted into custody.

## Summary of New Capabilities

- Detects both normal and context-exhaustion respawn collisions.
- Routes one deterministic custody notice through the existing Telegram topic-send funnel.
- Preserves sentinel-before-dedup ordering and all existing emergency-stop, pause, and exactly-once behavior.

## Evidence

- `tests/unit/respawn-collision-notice.test.ts`
- `tests/integration/telegram-forward-sentinel-intercept.test.ts`
- `tests/integration/exactly-once-ingress.test.ts`

