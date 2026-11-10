---
title: Pinned messages in conversations (app, dashboard, Telegram, Slack)
slug: conversation-pinned-messages
eli16-overview: conversation-pinned-messages.eli16.md
status: converged
approved: true
approved-by: "echo, under the standing grant for non-constitution changes (operator request: Justin, topic 134088, 2026-11-09 21:52)"
review-convergence: "2026-11-10T06:27:58.000Z"
review-iterations: 1
review-completed-at: "2026-11-10T06:27:58.000Z"
review-notes: "One independent review subagent (read-only, given the code): 12 findings, all folded into this spec and the build."
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
author: echo
created: 2026-11-09
tier: 2
---

# Pinned messages in conversations

## Why this exists

Operator request (Justin, 2026-11-09 21:52, topic 134088): "Conversations should support pinned messages (multiple) like telegram".

The conversations the Instar iPhone app and the dashboard's Conversations page show are app conversations, Telegram topics and Slack conversations. None of them can pin a message today. In Telegram the operator pins important messages (a decision, a link, a plan) so they stay one tap away at the top of the topic. The same should work everywhere Instar shows a conversation, and the pins must be the same whichever machine answers.

## What already exists

- **The app conversation store** (`src/core/AppConversationStore.ts`): one append-only event file per conversation, an SQLite index, events replicated to every machine through the `appConversations` replicated-store kind whenever native conversations are on. It already holds keys for Telegram topics (`telegram:<topicId>`) and Slack conversations (the registry key `slack:<team>:<channel>[:<thread>]`), for app-sent messages and platform files. A new event kind is the established way to add state here (`platform-media`, `transcript`); an older version refuses an unknown kind instead of storing it wrongly.
- **Conversation access** (`MobilePairingService.mayUse` via `deviceMayUse`, `teamConversationTarget`, `TEAM_ROUTE_TIERS`, `DEVICE_ALLOWLIST`, `BROWSER_ROUTES`): one shared check for who may read, send, rename, delete in a conversation, for owner phones, MSP phones, team phones and dashboard browser devices.
- **History reads**: `GET /mobile/chat/app/:key/messages`, `GET /telegram/topics/:topicId/messages`, `GET /mobile/chat/slack/:id/messages?machine=`. The dashboard (`dashboard/console/chats.js`) and the app poll these.
- **Platform pin calls**: `TelegramAdapter` already calls `pinChatMessage` for the dashboard topic; `SlackAdapter.pinMessage` calls `pins.add`.

## Design

### The data: one `pin` event kind

A pin or unpin is an immutable event in the conversation's own store file:

```
pin { pinnedMessageId, pinState: 'pinned' | 'unpinned', pinnedBy: { name, role }, preview?, source }
```

- `conversationKey` is the store key: the app conversation UUID, `telegram:<topicId>`, or the Slack registry key.
- `pinnedMessageId` is the message id the history read returns for that row (`messageId`): the app message id, the Telegram message id (digits), or the Slack `ts` / app message id for an app-sent Slack message. Pattern `[A-Za-z0-9._:-]{1,128}`.
- `pinnedBy.role` is `owner | msp | team | telegram`; `name` is the person's display name (≤128 chars).
- `preview` is the first 200 characters of the pinned message's text as the pinning machine sees it (server-derived, never taken from the client), with server file paths replaced the way history reads replace them. Absent when the pinning machine does not hold the message text. **Slack pins never store a preview:** Slack text otherwise stays on the machine holding the conversation, so the Slack pin list and the Slack history read (both served there) build the preview at read time from the rows they hold. Telegram and app previews are snapshots (the platforms here have no edits the store records), stored with the pin and replicated like the message itself.
- `source` is `app` (pinned from the app or dashboard) or `telegram` (seen in Telegram).
- The field is named `pinnedMessageId`, not `messageId`, so the index never mistakes a pin for a chat message and no existing reader that keys on `messageId` (delivery state, the events filter, previews) treats it as one.

**Reduction (any arrival order, every machine identical):** per `(conversation, pinnedMessageId)` the event with the greatest `(at, machineId, eventId)` wins. Because `at` is compared as text, a `pin` event's `at` must be exactly the UTC `toISOString()` form (anything else is refused at validation), and a writer stamps `at = max(now, current winner's at + 1 ms)`, so a machine whose clock is behind still wins with its newer choice and an answer never says `changed: true` while the list disagrees. The conversation's pins are the winners whose state is `pinned`, newest pin first. The index keeps one `pins` row per `(canonicalKey, pinnedMessageId)`, updated by that comparison inside `indexEvent`, so a rebuilt index reproduces it from the files.

**Bounds:** at most 100 pinned messages per conversation (a pin past that answers `409 too-many-pins`; unpinning is always allowed). The list read returns at most 100.

The index's `pins` table is cleared with the other derived tables in `rebuildIndex` and in the short-file re-index, so a rebuilt index reproduces it exactly from the files. The replicated record schema (`AppConversationsReplicatedStore` `KNOWN`) names the new fields (`pinnedMessageId`, `pinState`, `pinnedBy`, `preview`, `source`), so a pin never counts as dropped fields.

A pin event is not a message: it never changes `lastActivity`, the preview, unread counts or delivery state. `listConversations` already lists only `app:` keys, so a pin in a Telegram or Slack conversation never creates a phantom app conversation.

### Who may pin

Pinning changes what everyone in the conversation sees at the top, so it is treated as using the conversation: the same check as sending (`op: 'send'`).

- Owner phones and the owner's dashboard browser: every conversation they can use.
- MSP phones: what they may send in (their own app conversations; Slack only with the Slack grant; Telegram topics as today).
- Team phones (team access): a member with a `use` grant or their own conversation may pin; a guest or a `read` grant may see pins but not change them (`mayDoAsTeam(…, 'send', …)`). The route tier is `member` for the write and `guest` for the read, matching the history read and the send. Slack stays closed to team phones, as everywhere.
- The agent's Bearer token may read pins (agent awareness) but never write them: the POST handler refuses any principal that is not a device (`403 operator-device-required`) before anything else, never relying on `deviceMayUse` (which passes a token).
- A pinned message the reader may not read (team access 2b held-back rows, `mayReadMessageId`) is left out of that reader's pin list, and the writer is checked the same way: a POST for a message the writer may not read answers `404 unknown-message`. In an app conversation the message must be held in **this** conversation (`getMessageEvent(key, id)`), else `404 unknown-message`.
- The events feed shows a `pin` event only when the pinned message is held in that conversation on this machine and the reader may read it; otherwise the event waits (it cannot be checked).
- Exact team-gate mappings (`teamConversationTarget`): `POST /mobile/chat/app/<uuid>/pins`, `POST /mobile/chat/<topic>/pins` and `POST /mobile/chat/slack/<id>/pins` are `send`; the three GETs are `read`. Without these a read-grant member's POST would have been judged as a read.
- Rate: the POSTs have their own device bucket (`pins`, 30 a minute), separate from the read allowance; they are not `sendRoute` rules (a pin dispatches nothing to a session).

### Routes

All device-signed (same signature gate as reading and sending in that conversation); reads also accept the agent's Bearer token. Writes are idempotent by `requestId` (the same `requestIdTime` / age rules as sends): the event id is derived from `(deviceId, requestId)`, so a retry never pins twice.

| Route | Who | Notes |
|---|---|---|
| `GET /mobile/chat/app/:key/pins` | device (read), Bearer | |
| `POST /mobile/chat/app/:key/pins` | device (send) | any machine; the event replicates |
| `GET /mobile/chat/:topicId/pins` | device (read), Bearer | |
| `POST /mobile/chat/:topicId/pins` | device (send) | only the machine serving Telegram (`409 not-serving`, as a send) |
| `GET /mobile/chat/slack/:id/pins?machine=` | device (read), Bearer | the machine named, as the Slack history read |
| `POST /mobile/chat/slack/:id/pins` | device (send) | body names `machine`; another machine answers `409 wrong-machine`, as a Slack send |

POST body: `{ "messageId": "<id from the history row>", "pinned": true | false, "requestId": "<request id>" }` (+ `"machine"` for Slack).

Answers:

- `200 { ok: true, pinned, changed, mirror, mirrorDetail?, pins: [PinRow…] }` — `changed: false` when the message was already in that state (or a retry); `mirror` is `done` (also pinned in Telegram/Slack), `failed` (the platform refused; the pin is kept in Instar and `mirrorDetail` says why in plain words), `unavailable` (the platform cannot pin this message, for example a message sent from the app into Telegram has no Telegram message to pin), or `not-applicable` (an app conversation, or nothing changed).
- `400 bad-request` / `bad-message-id` / `bad-request-id` / `request-id-too-old`; `404 unknown-conversation`; `409 too-many-pins`; `409 not-serving` (Telegram) / `wrong-machine` (Slack); `429 too-many-requests`; `503 native-conversations-off` / `pins-off` / `slack-not-configured` / `slack-owner-unset`.

GET answer: `{ conversationKey, pins: [PinRow…] }`, where

```
PinRow = { messageId, pinnedAt, pinnedBy: { name, role }, preview: string | null, source: 'app' | 'telegram' }
```

**Pins also ride on every history read.** The three history answers gain `pins: [PinRow…]` (only when the feature is on and the reader may read the conversation). The dashboard and the app poll history already, so a pin made on another device or in Telegram shows up on the next poll with no extra request. App conversations polled through the events feed see the `pin` event itself; the events feed checks `mayReadMessageId` against `pinnedMessageId` for pin events, and the dashboard re-reads the pins when one arrives.

### Telegram

- **Outward:** a pin made in the app or dashboard on a real Telegram message id (digits, below 2^52; ids at or above 2^52 are the stand-ins for messages typed in the app) calls `pinChatMessage { chat_id, message_id, disable_notification: true }` in the topic's chat (issues-group topics translated through `toWireParams`), and an unpin calls `unpinChatMessage { chat_id, message_id }`. `unpinChatMessage` joins the egress door's list of methods that carry ids, not prose (`NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS`). The bot needs the "pin messages" admin right; without it Telegram refuses and the answer is `mirror: 'failed'` with "Telegram did not let the agent pin this message. The pin is kept in the app." The Instar pin stays: Instar's list is the source.
- **Inward:** when an authorized person pins a message in Telegram, the bot receives a service message carrying `pinned_message`. The adapter now hands it to the server (`onTopicMessagePinned`) instead of dropping it, and the server records a `pin` event with `source: 'telegram'`, `pinnedBy: { name: <Telegram first name>, role: 'telegram' }`, stamped with the server's time (not Telegram's date). The event id is derived from the topic, message id and service message id, so a redelivered update never pins twice; already pinned ⇒ nothing written. Only the machine polling Telegram sees it; the event replicates.
- **Agents whose lifeline owns polling** (the server runs send-only): the lifeline drops text-less messages, so it now forwards a pin service message to `/internal/telegram-forward` as `{topicId, text: '', pinOnly: true, pinnedMessageId, pinServiceMessageId, fromUserId, fromFirstName}`, the same way it forwards topic names. The server accepts it only from a lifeline-proven sender, and the adapter (`handleForwardedPin`) records it only when `fromUserId` is authorized here.
- A pin by someone not authorized here (an anonymous admin appears as `GroupAnonymousBot`, or a stranger) is ignored quietly: no reply, no unknown-user handling.
- **Plain limit:** Telegram sends a bot nothing when someone *unpins* in Telegram, and a bot cannot list a topic's pins (`getChat` returns only the chat's newest pin). So an unpin made in Telegram is not seen; the pin stays in the app until someone unpins it there (which unpins in Telegram too, harmlessly if already unpinned). Pins made in Telegram before this version are not imported.

### Slack

- **Outward:** for a real Slack message `ts` (`^\d{9,12}\.\d{1,8}$`, never an app message id) in a conversation held on this machine, a pin calls `pins.add { channel, timestamp }` and an unpin `pins.remove`. Slack's `already_pinned` / `no_pin` answers count as `mirror: 'done'`. These need the bot's `pins:write` scope; a missing scope (or any refusal) answers `mirror: 'failed'` with "Slack did not let the agent pin this message (it may need the pins permission). The pin is kept in the app." and the pin is kept in Instar. A message sent from the app into Slack is stored under its app message id (its mirror line's `ts` is not recorded), so it is pinned in Instar only (`mirror: 'unavailable'`).
- **Inward:** not read back. Reading Slack pins needs `pin_added` / `pin_removed` events or `pins:read`, which the Slack app does not subscribe to today. Pins made inside Slack do not appear in Instar; stated in the release note.

### The off switch

`mobilePairing.native.pins.enabled` (default **true** when absent; read live). Off ⇒ the pin routes answer `503 pins-off`, history answers carry no `pins`, Telegram pins are not recorded. Pins need native conversations on (the store); with native off every route answers `503 native-conversations-off` as its neighbours do. No migration is needed: an absent field means on.

### Dashboard (`dashboard/console/chats.js`, `chats-model.js`)

- **Pinned bar** under the conversation title, like Telegram: one line showing "Pinned" + the newest pin's preview, and when there are several, "1 of N". Tapping it scrolls to that message and flashes it, then the bar steps to the next pin (Telegram's behaviour). A message not loaded yet is looked for in up to 5 earlier pages; if it is still not found the bar says "That message is further back than the dashboard has loaded."
- **A list button** ("All pins") opens a sheet with every pin: preview, who pinned it and when, and an Unpin button for people who may change pins.
- **Per-message menu:** each bubble with a message id gets a small "⋯" button opening a menu with Pin / Unpin (a tap on the bubble's menu, never a URL parameter — signed writes start only from an action in the page, as today). After a pin, the bar updates from the answer's `pins`; a `mirror: 'failed'` answer shows its plain sentence in the status line.
- Pins arrive with every history answer (Telegram, Slack, app pool fallback) and are re-read when an app events page carries a `pin` event.
- Checked at 390 px and 1280 px wide in jsdom-driven unit tests (bar, sheet and menu present, no horizontal overflow styles) plus a Playwright pass against a throwaway agent where available; never against the operator's real agent.

### The iPhone app

This change ships the server routes and the dashboard. The app's own pin bar and message menu are built in the app's codebase against the contract above; no iOS build is made from this change (the Studio is shared with a live agent). The operator's request lives in topic 134088 and the app work is reported there.

### Agent awareness

`CapabilityIndex` (the native conversations entry) and the CLAUDE.md "Native app conversations" section gain one line naming the pin routes and the Telegram/Slack limits; existing agents get the line through `PostUpdateMigrator` (content-sniffed, inserted after the dashboard conversations line, idempotent).

## Decision points touched

- **Who may pin** — reuses the existing `mayUse` check with `op: 'send'` and the existing tier table; no new permission logic. A deterministic access check on a write is the right shape (an invariant, not a judgment call).
- **Mirror outward** — deterministic: a real platform id and a platform that accepts the call. A refusal never removes the Instar pin and never blocks the answer.
- No block/allow decision on messages, sessions or delivery is added or changed.

## Multi-machine posture

**Replicated.** Pins are `pin` events in the app conversation store and travel with the `appConversations` replicated-store kind to every machine (the store is agent-wide whenever native conversations are on). Every machine reduces the same events the same way, so any machine answers the same pin list. Writes follow the conversation's existing write placement: app conversations on any machine; Telegram only on the machine serving Telegram (which is also the only one that can call the Bot API and the only one that sees Telegram pin service messages); Slack only on the machine holding that Slack conversation (the one with the Slack bridge). No user-facing notices are emitted. No URLs are generated. Durable state is the event files, which never strand on a topic move (they are in every machine's store).

**Older machines:** a machine on an older version refuses a `pin` event (unknown kind) and counts it, exactly like `platform-media` and `transcript` when they shipped. A pin it refused is never stored there and nothing sends it again, so on that machine it is lost for good; once it updates it shows pins written after its update. Every other machine is unaffected, and the dashboard and app read pins from whichever machine answers. This is stated, not hidden.

**Status surfaces:** none added or changed.

## Rollback

Set `mobilePairing.native.pins.enabled: false` (live). Or revert the code: an older version ignores the stored `pin` events at validation (they stay in the files, inert); if such a version rebuilds its index it logs one "invalid event" report per stored pin line, which is noise, not damage. No data migration. Telegram/Slack pins made by the mirror stay pinned on those platforms; they are ordinary platform pins the operator can remove there.

## Tests

- Unit: `validateAppEvent` for `pin` (valid, missing fields, bad ids, unknown roles), the reduction in every arrival order, index rebuild reproduces pins, pin events never touch `lastActivity`/preview/unread, the 100 cap; the route module (each platform: pin, unpin, idempotent retry, unchanged state, access refusals for guest/read-grant/MSP, Telegram not-serving, Slack wrong-machine, mirror done/failed/unavailable, pins on history answers); the Telegram adapter's pin service message hand-off and the `unpinChatMessage` egress allow; the dashboard model (pin bar text, next-pin cycling, per-message menu label) and page (bar, sheet and menu render; pin call is device-signed; 390/1280 widths); allowlist coverage (new routes flagged `conversationRef`, browser and team tiers); PostUpdateMigrator line insertion idempotent.
- Integration: the routes through the real HTTP pipeline with a device-signed request, including the history answer carrying `pins`.
- E2E: the feature is alive through the production init path (routes answer 200, not 503).
