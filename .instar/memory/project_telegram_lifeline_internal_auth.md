---
name: TelegramLifeline auth on /internal/*
description: Shipped — TelegramLifeline sends Bearer auth on /internal/telegram-forward and /internal/telegram-callback, fixing 0.28.53 regression where inbound Telegram messages 401'd silently
type: project
---

**Fact:** Post-0.28.53, `TelegramLifeline.forwardToServer()` and `handleCallbackQuery()` include `Authorization: Bearer <authToken>` when `projectConfig.authToken` is set (verified at `src/lifeline/TelegramLifeline.ts:802,851`). Previously they sent only `Content-Type`, which after 0.28.53 tightened `/internal/*` to require bearer auth caused every inbound Telegram message to 401 and get dropped with a "Server is restarting" fallback reply.

**Why:** 0.28.53 added bearer auth enforcement on `/internal/*` middleware (commit 42cb9ee, PR3 security hardening) but missed the matching client update in `src/lifeline/TelegramLifeline.ts`. Subsequent patch closed that gap.

**How to apply:** If Justin reports "I send a Telegram message and get 'Server is restarting'" or "inbound Telegram stopped working after upgrade" — check the agent's installed version. If it's 0.28.53, apply the vNEXT patch (or patch `node_modules/instar/dist/lifeline/TelegramLifeline.js` to include the Authorization header). Outbound (agent → user via Bot API) was never affected. Regression test asserting forwardToServer includes the bearer header is tracked as a follow-up — worth writing if it hasn't been added yet.
