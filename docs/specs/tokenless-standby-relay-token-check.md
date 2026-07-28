---
title: Tokenless-standby reply relay fires on an unresolved (non-string) bot token
slug: tokenless-standby-relay-token-check
status: approved
review-convergence: 2026-05-31T19:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during the live
  multi-machine transfer proof (topic 13481, 2026-05-31). The forward transfer
  was proven live; this closes the last mile (the moved session's reply reaching
  the user). Flagged in the PR per cross-agent discipline.
---

# Tokenless-standby reply relay: fire on an unresolved bot token

## Problem

A multi-machine pool standby (e.g. the Mac Mini) that serves a moved session is
deliberately *tokenless* — it must not hold the Telegram bot token, so it can't
double-poll and re-trigger the 409 poller-conflict the single-owner invariant
prevents. The reply path already has the fix for this (`outboundRelay`, bug #7):
`TelegramAdapter.sendToTopic` is supposed to detect "no bot token" and relay the
send to the Telegram-owning lease holder's `/telegram/reply/:topicId`.

But the detection was `if (!this.config.token && this.outboundRelay)`. A standby's
bot token is *externalized* and arrives at the adapter UNRESOLVED as a non-string
placeholder — `{ secret: true }` — not `null`. `!{ secret: true }` is `false`, so
the guard concluded a token existed, skipped the (already-wired) relay, and
attempted a doomed direct Telegram API call with the placeholder. The moved
session's reply returned HTTP 200 internally but never reached Telegram, and no
relay was ever attempted.

Observed live (topic 8882, 2026-05-31 16:46 UTC): POSTing a reply to the mini's
`/telegram/reply/8882` returned `{"ok":true}` but the message never appeared in
Telegram, with NO outbound-relay log on the mini and NO inbound relay on the
laptop. The mini's config carried `botToken: { secret: true }`.

## Solution

Treat only a non-empty STRING as a usable bot token; any other value (the
`{ secret: true }` placeholder, `null`, `undefined`, `''`) means "no usable
token" → route through `outboundRelay`:

```ts
const hasUsableBotToken = typeof this.config.token === 'string' && this.config.token.length > 0;
if (!hasUsableBotToken && this.outboundRelay) { /* relay (bug #7) */ }
```

This is the minimal, defensive fix: it makes the tokenless detection robust to
how the externalized secret actually materializes, without changing the relay
mechanism (which is correct and already wired in server.ts to POST the lease
holder's `/telegram/reply` with the resolved auth token).

## Scope

- `src/messaging/TelegramAdapter.ts` — the `sendToTopic` relay-decision only.

## Testing

`tests/unit/telegram-tokenless-relay.test.ts` constructs a real `TelegramAdapter`
with the `{ secret: true }` placeholder (and `null`) + a spy `outboundRelay` + a
spy `fetch`, calls the REAL `sendToTopic`, and observes:

- `{ secret: true }` placeholder → `outboundRelay` invoked once, `fetch` never
  called (the exact standby bug — no more doomed direct send).
- `null` token → relays.
- a real string token → sends directly (`fetch` called, relay not).

## Non-goals

- Does not change `outboundRelay` itself, the lease/holder resolution, or the
  single-Telegram-owner invariant.
- The full "move via Telegram → mini serves → reply lands" round trip is verified
  live on deploy; this spec covers the relay-decision unit fix.
