## What Changed
The Instar app can now show what you have not read, the way Telegram does.
- **A read marker per person per conversation.** Instar keeps, for each person and each conversation, the newest message that person has seen. The marker only moves forward, it is replicated to every machine the agent runs on, and a machine that missed the live stream catches up from any peer at boot. A person's own reply counts everything before it as read, on every platform.
- **Counts on the list.** For a phone, every row of `GET /mobile/conversations` carries `hasUnread`, `unreadCount` (exact to 100, then `unreadMore` says the count is a floor, shown as "N+"), and `readUpTo`, the position of the "Unread messages" divider. The page carries `unreadTotal`, `unreadTotalMore` and `unreadBeyondPage`. Conversations that existed before the update start quiet; new activity counts.
- **The phone reports what it read.** `POST /mobile/conversations/read` takes 1-50 marks `{ref, id, atMs, machine?}` and answers `{results:[{ref, ok, readUpTo?, unreadCount?, unreadMore?, error?}]}`. A mark for a conversation held on another machine is forwarded there once; an unreachable holder answers `pending` and the phone keeps the mark.
- **The app badge.** A reply push carries `aps.badge`, the phone's unread total over app conversations. Telegram and Slack badge their own apps, so they are left out of the push.
- **Telegram and Slack have no per-user read state for a bot**, so the marker in Instar is the source for them too; the app says so once in the conversation info.
- `GET /mobile/conversations/read-markers` (the agent's token only) is the catch-up between the agent's own machines. The agent's own Bearer reads carry no read fields.
- Off switch: `mobilePairing.native.unread.enabled: false` turns unread off alone; it is on wherever native app conversations are on.

## What to Tell Your User
The app now shows how many messages you have not read, on the conversation list and inside each chat, and the app icon shows a count for app conversations. Reading on one phone clears it on the other, and your own reply counts everything before it as read. For Telegram and Slack conversations the count is kept here in Instar: messages you read in Telegram or Slack itself are not known here, but anything before your own reply there counts as read.

## Summary of New Capabilities
- Per-person read markers for app, Telegram and Slack conversations, replicated across machines.
- Unread counts, the divider position and a page total on the conversation list; `readUpTo` on history reads.
- `POST /mobile/conversations/read` for the phone's read reports, with once-only forwarding to the holder.
- `aps.badge` on reply pushes; `GET /mobile/conversations/read-markers` for the catch-up between machines.

## Evidence
- `tests/unit/conversation-read-markers.test.ts` (27 tests): positions and ids across platforms, ref canonicalisation, reader keys, the counting walk (own reply, other people, the 100 cap, a window ending early, a baseline, mixed precision), the replicated kind's schema, the forward-only order-independent merge, removal evidence surviving a reload, coalesced emits with retry after a refusal and the state file as the outbox across a restart, the size alarm, the catch-up page order, the service's baseline rules, per-platform counts, read reports (held, unheld-limited, repeat, unknown, forwarded, unknown reader), the badge and gc.
- `tests/integration/mobile-unread-messages.test.ts` (8 tests): the production auth middleware with a signed phone and the agent's token: list fields and totals for the phone and none for the token; an idle Telegram topic counted from the tail; unread off ⇒ no fields and 503; the read route advancing, limiting, repeating, refusing, requiring a reader on the token path, its own 60/min bucket; a mark forwarded to the peer that holds the topic lowering that peer's count; a pool list forwarding the reader and keeping the peer's Telegram count; the catch-up route Bearer-only, paged to the end, and a machine started empty catching up from one peer with nothing re-emitted.
- `tests/e2e/mobile-unread-messages-alive.test.ts`: an AgentServer booted through its production constructor on a development agent has the service wired to the real store, pairing and app store; a paired phone's list carries read fields and a total, the read route answers 200 (not 503), the catch-up route answers the token and refuses the phone, and the badge for that phone reads 1.
- Type check and all 52 lint steps pass; the neighbouring native-conversation, pool and media integration suites pass (71 tests).
