## What Changed
- **No PIN when you approve on the phone or in Telegram.** Setting up a browser for dashboard Conversations on an agent with a Telegram owner no longer asks for the dashboard PIN: the owner's approval with Face ID or in the private Telegram chat is the proof. Agents with no Telegram owner still ask for the PIN, because there it is the approval.
- **Guards that come with it.** Only one browser setup can wait for approval at a time; declining one pauses new browser setups for an hour; the browser's self-chosen name loses invisible formatting characters and can no longer become a link or bold text in the approval message; setup always needs the agent's own server key.

## What to Tell Your User
Setting up a browser for your conversations is now just: tap "Set up this browser", then approve on your iPhone or in Telegram. No PIN. If you ever get a browser request you didn't start, tap Decline: that also stops new ones for an hour.

## Summary of New Capabilities
- PIN-free browser setup when the owner approves on the phone or in Telegram, with one-pending and decline-pause guards.

## Evidence
- `tests/unit/mobile-browser-devices.test.ts`: no PIN with a Telegram owner (and a stale header ignored), PIN still required without one, Bearer required, one pending at a time, decline pause, format characters stripped, `activate()` guards.
- `tests/unit/notification-selectivity.test.ts`: the approval message is escaped HTML.
- `tests/e2e/dashboard-conversations-browser-alive.test.ts`: on the production boot path with no Telegram owner, a setup without the PIN is refused.
