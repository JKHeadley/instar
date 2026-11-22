# Telegram and Slack chats: fetch only what changed

<!-- bump: patch -->

## What Changed

`GET /telegram/topics/:topicId/messages` and `GET /mobile/chat/slack/:conversationId/messages` accept an optional `after` (an ISO time; Telegram also takes epoch milliseconds).

- With `after`, the answer keeps only the rows logged from two minutes before that time onward, and adds `changeFeed: { since, lookbackMs }`.
- The window applies to the finished answer, after the device join and the multi-machine merge, so it changes which rows are sent, never which copy of a row is sent.
- The Slack holder hop forwards `after`.
- The web chat's five-second check of an open Telegram or Slack conversation now sends `after`. Its 30-second full read is unchanged and is the safety net.
- A plain read is unchanged, and an older server ignores `after` and returns the plain page.

Spec: `docs/specs/telegram-slack-change-feed.md`.

## What to Tell Your User

- **Faster Telegram and Slack chats in the web chat**: "When you have a Telegram or Slack chat open in the web chat, it now only downloads new messages every few seconds instead of the last fifty each time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Change feed for Telegram and Slack history reads | Add `after=<newest message time you hold>` to the history read; the web chat does this automatically |

## Evidence

- `tests/integration/telegram-change-feed.test.ts`: 6 cases.
  - A plain read is unchanged.
  - The window applies to local and pool reads.
  - A device read never gets a weaker store copy of an app-sent row from outside the window. This case fails when the filter runs before the join.
  - Bad input gets a 400.
- `tests/integration/mobile-slack-from-app.test.ts`: the Slack window and its 400 cases.
- `tests/unit/mobile-slack-holder-proxy.test.ts`: the holder hop forwards `after`.
- `tests/unit/console-chats-page.test.ts` and `tests/unit/console-chats-model.test.ts`: the quick read sends `after` once it knows a time, and the pool read never does.
