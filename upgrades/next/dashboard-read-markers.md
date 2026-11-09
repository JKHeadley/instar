# Upgrade Guide — dashboard-read-markers

## What Changed

Reading a conversation in the dashboard (Work > Conversations) now counts as read for you everywhere: a browser device may call `POST /mobile/conversations/read`, the same read report the iPhone app uses, and the page reports the newest message it shows when the conversation is open and the window is in front. The person's one read marker moves forward, so the unread count on the phone drops too, like reading in Telegram Web clears the Telegram phone app. The dashboard list shows unread badges for the other conversations. Behind `mobilePairing.browser.enabled` (the browser device switch) and unread counts being on.

## What to Tell Your User

When you read a conversation in the dashboard, your phone stops showing it as unread, the same way Telegram Web and the Telegram phone app stay in step. The dashboard's conversation list also shows the unread number for the other conversations.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Unread counts stay in step between the dashboard and the phone | Read a conversation in Work > Conversations |
| Unread badges in the dashboard conversation list | Automatic |

## Evidence

`tests/e2e/dashboard-read-markers-alive.test.ts` boots a real agent with an owner phone and an owner browser. The agent replies and the phone's list shows `unreadCount: 1`; the browser reports the newest message read; the phone's list shows 0. With the route closed to browsers the same test fails (403). `tests/unit/console-read-marks.test.ts` checks the shared position rule. Driven live on a throwaway agent in a real browser: a reply in one conversation while another was open showed badge 1, opening it cleared the badge, and the server's count was 0.
