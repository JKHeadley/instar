# Telegram browser works again on Telegram Web 2.3 (687)

## What Changed
Telegram Web K 2.3 (build 687) was reviewed against its public source maps and added to the reviewed build list, so the reviewed enrollment command can switch the managed Telegram browser back on. Every page interface the driver uses is byte-identical to the reviewed build 686; no driver change was needed.

## What to Tell Your User
Telegram updated its web app again, and my safety check paused sending through your Telegram page until I had reviewed the new version. I've reviewed and approved it, so once this update is installed I can switch that back on. Nothing was sent while it was paused.

## Summary of New Capabilities
- Telegram Web K 2.3 (687) can be enrolled with the reviewed enrollment command.

## Evidence
Review: docs/specs/reports/telegram-message-origin-evidence/web-k-2.3-687-review.md. Live canary refusal on Echo, 2026-11-11 21:36 UTC: unreviewed-build, fingerprint 6809d24c…, messagesSent 0; the fingerprint recomputed from the three reviewed asset names matches, and the public files' digests equal the canary's. Tests: tests/unit/telegram-origin/browser-reenrollment.test.ts.
