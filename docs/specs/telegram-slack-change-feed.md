---
title: A change feed for Telegram and Slack chats
slug: telegram-slack-change-feed
status: approved
tier: 1
approved: true
approved-by: "Echo (agent), Tier 1 additive read parameter; Justin started the work card wc_1cd7f517af0e78ee with 'Go' in topic 145738 on 2026-11-22"
eli16-overview: docs/specs/telegram-slack-change-feed.eli16.md
---

# A change feed for Telegram and Slack chats

## Problem

App conversations already have a change feed (`GET /mobile/chat/app/:key/events?cursor=`): a client asks
for what happened after its cursor and gets only that. Telegram and Slack conversations have none.
Every client that shows one (the web chat, and the native apps) re-reads the newest page every few
seconds:

- the web chat's leader tab runs a `newest` read of 50 rows every 5 s per open Telegram/Slack
  conversation (`dashboard/console/chats-model.js` `INTERVAL.newest`), plus a full `pool` read every 30 s;
- each `newest` read makes the server build, join (origin, media, authorship) and serialize 50 rows,
  and the client download and re-render them, although usually nothing changed.

Parity row W10 (Telegram parity document, Justin's speed priority) and work card
`wc_1cd7f517af0e78ee` ask for the agent to serve only what changed, and for the web chat to use it.

## Design

### 1. An `after` parameter on both history routes

`GET /telegram/topics/:topicId/messages` and `GET /mobile/chat/slack/:conversationId/messages`
accept an optional `after`:

- Telegram: an ISO time or epoch milliseconds (the same forms `before` accepts).
- Slack: an ISO time.
- `after` together with `before` (or `beforeMessageId`) is `400`: one read pages one way.
- An unparseable `after` is `400`.

Meaning: "the newest row I already hold was logged at `after`". The server answers the rows logged at
or after `after − 120 s` (the **lookback**, `CHANGE_FEED_LOOKBACK_MS = 120_000`), oldest first, at
most `limit` of them (the newest `limit` when more qualify, exactly as a plain read keeps the newest).
Every other field of the answer (`readUpTo`, `pins`, `historyCursorVersion`, `nextBefore`,
`conversationKey`, `pool`) is unchanged, so a client merges an `after` answer exactly like a plain one.
The answer adds `changeFeed: { since: <ISO cutoff>, lookbackMs: 120000 }` so a client can tell the
server honoured the parameter (an older server ignores `after` and returns the plain newest page,
which is still correct, only larger).

Why a time-with-lookback cursor rather than an exact sequence cursor: the Telegram log is
append-only but its timestamps are not strictly monotonic across machines and senders, Slack rows
come from Slack's own history with Slack's times, and neither source has a per-row sequence number
that survives a restart. A lookback window re-sends the last two minutes of rows (small), and the
client already de-duplicates by row id (`mergeBubbles`), so a row stamped slightly earlier than one
the client already holds is still delivered.

### 2. What the server reads

The window trims the **finished** answer, after every join and merge. It changes which rows are
sent, never which copy of a row is sent:

- Telegram, local read: the same in-memory tail (`getTopicHistory`, no log-file read), then the
  device join and origin join exactly as a plain read, then the window. Filtering before the device
  join would be wrong: the join re-adds every app-sent message it was not given as a weaker store
  copy (`messageId: null`), which would replace the full Telegram row in the client and make the pin
  mark and placeholder matching flicker between the 5 s and 30 s reads (review round 1, finding 1).
- Telegram, `scope=pool`: the peer fan-out, merge, own-row-wins dedupe and device join are
  unchanged; the window applies to their result. Filtering this machine's rows first would let a
  peer's copy of a row win over this machine's own copy (review round 1, finding 2). Each machine
  still returns its newest page: those pages are bounded already (100 rows, 512 KiB) and the web chat
  does not send `after` on pool reads (section 3), so carrying `after` over the signed mesh verb would
  change a versioned peer protocol for no client-visible saving. This is a design choice, not a gap.
- Slack: the store rows and `bridge.history` rows are read as for a plain read; rows older than the
  cutoff are skipped before their origin and file shaping. Slack has no device join that re-adds rows,
  so skipping early is safe there.

The saving is the answer itself: in a quiet chat a few rows (the lookback window) instead of 50,
which the server serializes and the client downloads and re-renders.

### 3. The web chat uses it

In the web chat's leader tab, the 5-second `newest` task for a Telegram or Slack conversation sends
`after=<newest row time seen in an earlier newest answer for that conversation>`. That time comes only
from server rows in this machine's own `newest` answers (the page's `noteNewest`), never from the
shown bubbles (a `local:` placeholder carries the browser's clock, which may drift) and never from a
pool answer (its rows carry other machines' clocks: a peer running more than two minutes fast would
otherwise hide this machine's rows from the quick read). The first `newest` read for a conversation
is therefore a plain read. Every tab records the time from broadcast `newest` results, so a new
leader carries on.

The 30-second `pool` task stays a full newest-page read. It is the safety net: anything the lookback
window could miss (a row stamped more than two minutes before the newest row, or a Slack message
edited in place) is picked up there within 30 s, the same as today.

The focused tab's `pollNow` and the first load stay plain reads.

The page sets `nextBefore`, `oldestTs` and the "Earlier messages" control only on a first load or a
scroll-back page, never on a `newest` answer, so a small `after` answer cannot disturb scroll-back.

## Non-goals

- Native apps (iPhone, Mac, Windows, Android, Linux) adopting the parameter: each app's own parity
  card carries that (`wc_77670e12ec07c169` for iPhone and Mac; Windows/Android already use the app
  change feed for app chats). The parameter is additive, so apps adopt it independently.
- Edits and deletions as events: neither source records them as events today.

Guidance for an app adopting `after`: an `after` answer describes only the window. Take scroll-back
cursors (`nextBefore`, the oldest row) from plain reads and scroll-back pages only, and keep a
periodic plain read as the safety net, as the web chat does.

## Decision points

None. This is a read-side filter on rows the caller is already allowed to read. It gates nothing,
blocks nothing and changes no permission check (the same `deviceMayUse` / owner checks run first).

## Multi-machine posture

Proxied-on-read, unchanged: a pool read still merges every machine's rows; `after` filters the merged
result. A Slack read routed to another machine through the holder hop forwards `after` with the rest
of the query.

## Tests

- Unit/integration: Telegram local and pool reads with `after` return only rows at or after the
  cutoff, include the lookback window, keep `readUpTo`/`pins`, refuse `after`+`before`, refuse a bad
  `after`, and a plain read is byte-for-byte unchanged.
- Slack: the same for the Slack route.
- Web chat model: the `newest` task path carries `after` once a time is known and the `pool` path never does.

## Rollback

Revert the commit. Clients that send `after` to a server without it get the plain newest page, which
they already handle.
