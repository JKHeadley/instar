---
title: Unread Messages in the App
description: A read marker per person per conversation, replicated across the agent's machines, so the Instar app shows unread counts, an "Unread messages" divider and an icon badge the way Telegram does.
---

Before this, the Instar iPhone app had no idea what you had read: every conversation opened at
the newest message, the list showed no counts and the icon had no badge. Unread Messages gives
Instar a **read marker** for each person in each conversation, keeps it on every machine the agent
runs on, and turns it into counts, a divider and a badge. Spec:
`docs/specs/mobile-unread-messages.md`.

## What it does

- **A read marker per person per conversation.** The phone reports what it has read as you scroll.
  Instar stores the newest message position each person has seen, moves it only forward, and
  replicates it to every machine, so reading on one phone clears the count on your other phone.
- **Your own reply counts everything before it as read**, on app, Telegram and Slack conversations.
- **Counts on the list.** Every row carries `hasUnread`, `unreadCount` (exact to 100, then
  `unreadMore` means the count is a floor shown as "100+") and `readUpTo`, the position of the
  "Unread messages" divider. The page carries `unreadTotal`, `unreadTotalMore` and
  `unreadBeyondPage` for the Chat tab.
- **Quiet start.** The first list read after the update sets the person's baseline, so
  conversations that already existed start at zero and only new activity counts.
- **The icon badge.** A reply push carries `aps.badge`, the phone's unread total over app
  conversations. Telegram and Slack badge their own apps, so they are left out of the push.
- **Telegram and Slack have no per-user read state for a bot**, so the marker in Instar is the
  source for them too. The app says so once in the conversation info: messages you read in Telegram
  or Slack itself are not known here, but anything before your own reply there counts as read.

## Routes

- `GET /mobile/conversations` — for a phone, every row gains the read fields above; `?scope=pool`
  forwards the reader to each machine as `reader=` and keeps each peer's Telegram count.
- `POST /mobile/conversations/read` — the phone's read report: `{ marks: [{ ref, id, atMs, machine? }] }`,
  1–50 marks, with its own 60-per-minute bucket. Each mark answers `ok` with `readUpTo` and the new
  count, or `unknown-conversation` (drop it), `pending` (the holder is unreachable; keep and resend)
  or `reader-unknown-here`. A mark for a conversation held on another machine is forwarded there once.
- `GET /mobile/conversations/read-markers` — the agent's token only: this machine's merged markers,
  paged, the catch-up another of the agent's machines reads at boot.
- The history reads (`GET /mobile/chat/app/:key/messages`, `GET /mobile/chat/slack/:id/messages`,
  `GET /telegram/topics/:id/messages`) carry `readUpTo` for a phone.

## How it is built

- `ConversationReadMarkerStore` (`src/core/ConversationReadMarkers.ts`) holds the markers and
  baselines in memory, flushes `state/conversation-read-markers.json` atomically at most every
  5 seconds, and shares its own advances through the replicated kind `conversation-read-marker`.
  Landing a peer's record is a forward-only merge (the furthest position, the earliest baseline),
  order-independent, and never emits. Each key remembers what it has shared, so the state file is
  the outbox after a crash or a refused emit.
- `ConversationUnreadService` (`src/core/ConversationUnreadService.ts`) counts over the sources the
  list already loads (the app store's newest page, the Telegram in-memory tail, the Slack log tail
  parsed once per request), stores the own-reply inference as a marker, applies read reports with
  the holder rule (a held message's own position; an unheld one limited to the newest message held),
  computes the badge, and runs the boot catch-up from any reachable peer with a saved cursor and a
  five-minute retry that gives up on a peer after twelve failures until it comes back.
- `wireReadMarkerStore` (`src/core/ConversationReadMarkersWiring.ts`) builds the store on the
  replication path at boot: the emitter hook and the landing of records already in the peer streams.

## Switches and rollback

- `mobilePairing.native.unread.enabled` — true wherever native app conversations are on; `false`
  turns the counts, the badge and the two routes off alone. Native chat off turns everything off.
- Reverting leaves the state file and journal records unread by an older build; the app falls back
  to phone-only markers on a 404. No migration, nothing rewritten.

## Multi-machine posture

Read markers and baselines are **replicated** (the journal kind for live advances, the catch-up route
for anything that rotated out of the journal window). Telegram history stays machine-local as today,
with counts **proxied on the pool read**. The badge is computed identically on whichever machine
pushes.
