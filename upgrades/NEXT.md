---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a conversation moved to your other machine can now reply to you

The final piece of the multi-machine "move this conversation to my other machine"
feature. Telegram only allows one program to use a given bot at a time, so in a
two-machine setup only the main machine holds the bot, and the backup deliberately
holds none (to avoid two programs fighting over the same bot — a real failure we fixed
earlier). That meant a conversation moved to the backup machine could run there but
couldn't actually send a reply — it came out silent.

This release adds a relay: when the backup machine wants to reply but has no bot, it
hands the message to the machine that does hold the bot, which sends it normally. So
your reply comes through, and there's still only ever one program using the bot — no
fighting, no duplicate messages. A machine that holds its own bot is completely
unaffected.

## Summary of New Capabilities

- `TelegramAdapter` gains an `outboundRelay` hook. When the adapter has no bot token,
  `sendToTopic` routes the send through it (the server wires it to POST the
  Telegram-owning lease holder's `/telegram/reply`), instead of failing silently. A
  token-holding adapter sends directly as before; a relay that can't deliver throws
  rather than dropping the message.

## What to Tell Your User

If you run your agent across more than one machine and move a conversation to another
one, that conversation can now reply to you — its replies are relayed through the
machine that owns your messaging bot, so you hear back without any risk of the two
machines clashing over the bot. Only relevant when the multi-machine session pool is
on; single-machine agents are unaffected. Nothing to configure.

## Evidence

- Found live: the backup machine's Telegram adapter had no bot token, so a moved
  session's reply was sent with no token and silently vanished.
- Unit, `tests/unit/TelegramAdapter.test.ts`: a tokenless adapter routes the send
  through the relay (the Telegram API is not hit, the relayed id is returned); a
  token-holding adapter sends directly and never consults the relay; a relay that
  returns nothing throws instead of silently dropping the reply.
- 19 TelegramAdapter tests pass; tsc --noEmit clean.
- Spec, `docs/specs/standby-telegram-outbound-relay.md` plus the .eli16.md sibling.
- Side-effects, `upgrades/side-effects/standby-telegram-outbound-relay.md`.
