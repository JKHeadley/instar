---
title: Pin conversations to the top of the list
slug: conversation-list-pins
tier: 1
eli16-overview: docs/specs/conversation-list-pins.eli16.md
---

# Pin conversations to the top of the list

Operator request (Justin, 2026-11-14 01:29 PST, Telegram topic 134088): "being able to pin conversations".

This pins WHOLE conversations in the conversation list. It is not pinned messages inside a conversation
(that is docs/specs/conversation-pinned-messages.md).

## What a pin is

- A pin belongs to one person, the same identity unread counts use (`owner`, `msp:<machine>:<user>`,
  `team:<personKey>`, see docs/specs/mobile-unread-messages.md §3.1). Every owner phone and the owner's
  dashboard browser share one set of pins.
- It names a conversation by its canonical ref: `app:<uuid>`, `telegram:<topicId>`, `slack:<machine>:<id>`.
- At most 50 pinned conversations per person; a 51st is refused (`409 pin-limit`).
- Pinned conversations lead the list, newest pin first.

## Store and replication

- `src/core/ConversationListPins.ts`. Every change is an immutable row `{eventId, reader, ref, pinned, atMs}`.
  For each (reader, ref) the latest row wins by `atMs`, then `eventId` by code units, so the fold is
  order-independent and the union of every machine's rows has no conflicts. The store keeps only the
  latest row per (reader, ref); an unpin row stays as the tombstone that keeps an older pin from returning.
  A new local row's `atMs` is always after the row it replaces, so a local change wins whatever the clock says.
- State file `state/conversation-list-pins.json`, atomic (tmp, fsync, rename, mode 0600), written on each change.
  It is also the outbox: each row records whether it was shared.
- Replicated kind `conversation-list-pin`, store key `listPins`, record key `sha256("conversation-list-pins\0"+eventId)`
  (the shape of the recommended-services kind). Journal retention never deletes (`rotateKeep: 0`): rows are
  few and small, and a machine that joins later still receives every pin. Advertised with native app
  conversations. A refused or dark emit leaves the row unshared; it is sent again at the next boot.
- Boot (`ConversationListPinsWiring.ts`): land other machines' rows from the peer streams, then send this
  machine's unsent rows. Live: the journal commit observer lands each committed batch.

## Wire contract

`POST /mobile/conversations/pins` body `{ ref, pinned: boolean }`.
- Principal: a device (phone or approved browser). A Bearer call must carry `?reader=<key>` and acts for that person.
- `200 { ok: true, changed: boolean, pinned: [{ ref, atMs }] }`; a repeat of the current state is `changed: false`
  and writes nothing.
- `400 bad-pin` (ref not canonical or `pinned` not a boolean), `400 reader-required` (Bearer without `reader=`),
  `403 operator-device-required` (no resolvable person), `404 unknown-conversation` (the person may not see it,
  or an app conversation that does not exist; the same answer for both), `409 pin-limit` (with the current `pinned`),
  `429 too-many-requests` (30 per minute per device), `503 list-pins-off`, `503 native-conversations-off`.
- Unpinning a conversation the person already pinned is allowed even after they lost access to it.

`GET /mobile/conversations` — on the first page only (no `cursor`), for a resolvable person (a device, or a Bearer
read with `reader=`), the body also carries:
- `pinnedRefs: [{ ref, atMs }]` — every pinned ref the person may see, newest first.
- `pinnedRows: [<list row>]` — a full list row for each, in pin order, found in the page, an answering peer's
  rows (pool read), this machine's first 200 rows, or (app conversations) straight from the store. A pinned ref
  with no row anywhere (deleted, or the machine that holds it is down) is absent from `pinnedRows` and stays in
  `pinnedRefs`. The rows carry the same unread fields and tree field as list rows.
- The Chief of Staff `pinned` field is unchanged.
- With the switch off, or on a later page, neither field is present.

Device route rules: `POST /mobile/conversations/pins` is a device route (own bucket `list-pins`, 30/min), open
to browser devices and to team phones at the guest tier (pinning orders the person's own list; the route checks
they may see the conversation).

## Off switch

`mobilePairing.native.listPins.enabled`: absent means on wherever native conversations are on (the pattern of
`native.pins` and `native.unread`), read live, so existing agents need no config migration; `false` turns it off.

## Dashboard

Work > Conversations: when the first page carries `pinnedRows`, a "Pinned" group leads the list, then
"All conversations"; each row gets a Pin or Unpin button beside it. A refused pin shows its plain words above
the list. Without pin fields (switch off) the page is unchanged.

## Multi-machine posture

Replicated (the `conversation-list-pin` kind). The list read on any machine shows the same pins once rows have
landed. No user-facing notices, no URLs. Status surface: none new; the CapabilityIndex row describes the feature.

## Agent awareness

`APP_CONVERSATIONS_LIST_PINS_LINE` in the app conversations CLAUDE.md section, added to existing agents by
`migrateClaudeMd()` after the pinned messages line; CapabilityIndex `appConversations` description.
