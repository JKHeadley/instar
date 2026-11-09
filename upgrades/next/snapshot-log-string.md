# Telegram browser snapshot failures log a readable reason

## What Changed
The server log line for a failed Telegram browser snapshot is now one plain string with the profile, error class and message. The previous release logged a details object that this server's logger printed as "[object Object]". The response the caller receives is unchanged.

## What to Tell Your User
When reading your Telegram page fails, my log now records the actual reason, so I can find and fix the cause faster.

## Summary of New Capabilities
- Failed Telegram browser snapshot reads name their cause in the server log.

## Evidence
Live on Echo, 2026-11-08T18:28:14Z: "[telegram-origin] browser snapshot unavailable [object Object]". Tests: tests/integration/telegram-origin-browser-drift.test.ts, tests/e2e/telegram-origin-webk-drift-reenroll.test.ts.
