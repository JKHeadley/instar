# Telegram browser works again on Telegram Web 2.3 (686)

## What Changed
Telegram Web K 2.3 (build 686) was reviewed against its public source maps and added to the reviewed build list, so the reviewed enrollment command can switch the managed Telegram browser back on. The review found that 686 reports a server answer it cannot read as an ordinary 400 error. The browser driver now treats that error as an unknown outcome (held and resolved by receipt) instead of a refusal, so a message the server may already have delivered is never treated as safe to send again. The browser snapshot route now logs why a read failed (error class and message) on the server; the response it returns is unchanged.

## What to Tell Your User
Telegram updated its web app this morning, and my safety check paused sending through your Telegram page until I had reviewed the new version. I've reviewed and approved it, so once this update is installed I can switch that back on. Nothing was sent while it was paused.

## Summary of New Capabilities
- Telegram Web K 2.3 (686) can be enrolled with the reviewed enrollment command.
- A 686 "result unreadable" error is held as an unknown outcome, never treated as a refusal.
- Snapshot failures are logged server-side with their cause.

## Evidence
Review: docs/specs/reports/telegram-message-origin-evidence/web-k-2.3-686-review.md. Live canary refusal on Echo, 2026-11-08 16:58 UTC: unreviewed-build, fingerprint 4520f562…, messagesSent 0, digests equal to the public files. Tests: tests/unit/telegram-origin/web-k-driver.test.ts, tests/unit/telegram-origin/browser-reenrollment.test.ts, tests/integration/telegram-origin-browser-drift.test.ts.
