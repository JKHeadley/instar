---
title: Only new messages in a chat read
---
A Telegram or Slack history read can ask for only what changed. Add `after=<time of the newest message you already have>` (an ISO time; Telegram also takes epoch milliseconds) to `GET /telegram/topics/<id>/messages` or `GET /mobile/chat/slack/<id>/messages`. The answer holds the messages from two minutes before that time onward, and `changeFeed` shows the window used. The web chat's five-second check uses it, and its 30-second full read stays as the safety net. Use a plain read (no `after`) when you need a full page or a scroll-back cursor. Example: `curl -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" "http://localhost:{{port}}/telegram/topics/<id>/messages?after=2026-11-22T08:00:00Z"`.
