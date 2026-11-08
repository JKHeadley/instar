# Upgrade Guide — dashboard-chats-phone-layout

## What Changed

Fixes to the dashboard Conversations page (#2966), found by its live proof in a real browser and a real Telegram test group:
- At phone width a long conversation no longer pushes the message box below the bottom tab bar. The open conversation fits the screen and the messages scroll inside it.
- A conversation opened from a link shows its real title instead of "Conversation".
- A message sent into a Telegram or Slack conversation finishes as "delivered". The page now reads those sends' `outcome` field, and the "sending" copy goes away as soon as the agent holds the message.
- A refusal that names its reason (for example "This agent has no Telegram owner to speak as") is shown as "not delivered" with the reason, instead of retrying forever. `GET /mobile/browser-devices/status` reports `telegramSend: true` only when a Telegram owner is present.

## What to Tell Your User

The dashboard's Conversations page works properly on a phone-size screen now: the message box is always on screen. Messages you send into Telegram from the dashboard show as delivered right away.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Conversations page fits a phone screen | Automatic |
| Telegram sends from the dashboard show delivered | Automatic |

## Evidence

`tests/unit/console-chats-page.test.ts` covers the title from a link and fails without the fix. `tests/unit/console-chats-model.test.ts` covers the `outcome` field and the final named 503. `tests/unit/mobile-browser-devices.test.ts` and `tests/e2e/dashboard-conversations-browser-alive.test.ts` cover `telegramSend` without an owner. The live proof drove the page at 390x844 with a 10-message conversation (composer at y=760, above the tab bar at y=780) and sent into a real Telegram test topic from the dashboard.
