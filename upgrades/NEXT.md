# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

**A conversation moved to a second machine can now reply to you.** When you move
a conversation to another machine (e.g. "move this to the Mac Mini"), that machine
serves the session but deliberately holds NO Telegram bot token — only one machine
may hold it, or Telegram throws a 409 poller conflict. The reply path already had
the fix for this: a tokenless standby relays its reply through the token-owning
machine (bug #7, `outboundRelay`).

But the "am I tokenless?" check was `!this.config.token`. On a standby the bot
token is *externalized* and arrives unresolved as a placeholder object
(`{ secret: true }`), not `null` — and an object is truthy, so the check concluded
"I have a token", skipped the relay, and attempted a doomed direct API call with
the placeholder. The moved session's reply returned 200 internally but never
reached Telegram.

The fix treats only a non-empty STRING as a usable bot token. The placeholder,
`null`, `undefined`, and `''` all now correctly mean "no usable token" → relay
through the token-owning machine. Token-holding machines (the normal case) are
completely unaffected — they still send directly.

## What to Tell Your User

Nothing to configure. If you run on more than one machine and move a conversation
to another one, that machine can now actually reply to you — previously a moved
session would go silent because its reply couldn't reach Telegram.

## Summary of New Capabilities

- `TelegramAdapter.sendToTopic` correctly detects a tokenless pool standby when
  the bot token is an unresolved (non-string) externalized placeholder, and routes
  the reply through `outboundRelay` instead of a doomed direct send.

## Evidence

**Reproduction (live, topic 8882, 2026-05-31 16:46 UTC):** POSTed a reply to the
Mac Mini standby's `/telegram/reply/8882`. Response was `{"ok":true}` (HTTP 200)
but the message never appeared in Telegram; the mini's `logs/server.log` showed NO
outbound-relay attempt and the laptop showed NO inbound relay. The mini's
`.instar/config.json` carried `botToken: { secret: true }` (externalized, never
resolved on the tokenless standby).

**Observed before/after (the relay decision, run in dev against the real
placeholder value):**

```
token value: {"secret":true}
BEFORE (!token):       HAS-TOKEN -> direct API send (DOOMED: placeholder is not a real token)
AFTER (typeof string): TOKENLESS -> relay (FIXED)
real string AFTER:     HAS-TOKEN -> direct API send (unchanged)
```

The truthy placeholder object flips the decision from "doomed direct send" to
"relay" — exactly the path the moved session needed. A real string token is
unchanged (still direct), so token-holding machines see no behavior change.

**Behavioral test:** `tests/unit/telegram-tokenless-relay.test.ts` constructs a
real `TelegramAdapter` with the `{ secret: true }` placeholder + spy `outboundRelay`
+ spy `fetch`, calls the REAL `sendToTopic`, and observes `outboundRelay` invoked
once with `fetch` never called (before this fix that path called `fetch` with the
bad token). 3/3 green.

**Live round-trip confirmation:** the full "move via Telegram → mini serves →
reply lands in 8882" round trip is confirmed against the deployed release on the
two-machine setup.
