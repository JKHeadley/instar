---
title: "Conversation list reads an in-memory view of the Telegram log (piece 1 of the freeze fix)"
slug: "conversation-list-log-view"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "conversation-list-log-view.eli16.md"
status: "draft"
feedback: "fb-52447f16-7d3"
split-from: "pull request 3598 (docs/specs/main-loop-freeze-conversation-list.md there)"
---

# Conversation list reads an in-memory view of the Telegram log

## Problem

On 2026-11-21 the Echo Studio server froze for 20-30 s at a time. A CPU profile taken during a freeze
put the largest self-time in `TelegramAdapter.scanLogForTopic` ← `getTopicHistory` ← the
conversation-list producer (`AgentServer.conversationFlatDeps.telegramTopics`) ← `GET
/mobile/conversations`. The list called `getTopicHistory(topicId, 1)` once per topic, and for each
topic whose tail was not cached that read and parsed the whole log file synchronously (31 MB on Echo).

## Scope (piece 1 of 3)

This is the first of three pieces agreed with the operator. It changes only how the conversation
list, and the unread source it uses, read Telegram history. Pull request 3598 holds pieces 2 and 3:
chat history, scroll-back, requests from other machines, and the first-fill behaviour.

- **Chat history, scroll-back, requests from other machines, the first tail-cache fill and the trim** keep the old code exactly.
- **No new request marker or protocol change.**
- **No waits of any kind.**

## Design

- `TelegramAdapter` keeps a view of the log file: the newest 500 rows per topic, exactly as a file
  read parses them. One pass of small awaited reads builds it, single flight, in the background (at
  server start where the app is on, and by a list request when it is not ready). It publishes in the
  turn that confirms the end of the file and records that file's identity (inode, device, size,
  modification time). Each successful save then adds its row and records the new identity.
- `getTopicHistoryForList(topicId, limit)` is the only reader of the view, used by the list producer
  and the unread source's Telegram history. A cached tail answers from the cache, as
  `getTopicHistory` does. Otherwise, while the view is usable, it answers from the view and **never
  writes the view's rows into the shared tail cache**, so the view can affect the list response and
  nothing else: no chat ever reads it. Otherwise it is `getTopicHistory` itself, immediately.
- The view is usable only when switched on, built, under its memory cap, and the file at the path
  has the identity it recorded. Any difference (another process appended, the file was replaced,
  a trim, a failed save, a save onto a torn last line) drops it, the request takes the old read, and
  the view is rebuilt in the background.
- Save path: the view is updated only after the save's own steps (trim check, cache update,
  notifications) have all run, and fully isolated: a failure there only drops the view.
- Memory cap: 64 MB of row text (the retained rows of a 100 000-line log of Echo's average row size
  fit well inside). A build over the cap is abandoned and a save that takes it over drops the view;
  either way the old read runs.
- An adapter without these methods (a stand-in in tests, an older build) keeps the old read.
- `telegramHistoryView.enabled: false` (default on; read live through LiveConfig where available)
  returns the list to the old read with no code change.
- Trim: the old code in both save paths, byte for byte; the only addition is a notice so the view
  rebuilds after a trim (`noteLogRotated()`; `MessageLogger`'s `onRotated` callback).

## Decision points touched

No gate, filter, block or allow decision is added, removed or changed. Fixed values: the 64 MB view cap and the 5 s to 5 min build backoff are resource brakes; on either, the old read runs.

## Multi-machine posture

Proxied-on-read. The view is derived, in-memory state over this machine's own log, with no durable
store. Each machine's list answers from its own view or its own file, and the existing `?scope=pool`
read is unchanged.

## Testing

- **Unit:** `tests/unit/telegram-list-log-view.test.ts`.
  - Answers equal a real file read.
  - No file read once ready; the old read runs immediately when not ready.
  - Other readers never use the view.
  - Saves, trims, torn lines and failed saves are followed.
  - A failed build is braked; the off switch works.
- **Unit:** `tests/unit/message-log-rotation-matches-old-code.test.ts` and
  `tests/unit/message-log-rotation-real-size.test.ts`. The trim must match an oracle of the old
  algorithm byte for byte, across both save paths at the real 20 MB and 100,000-line sizes, under
  injected read, rename and torn-write failures.
- **Integration:** `tests/integration/conversation-list-log-view.test.ts`. A cold list with the view
  ready does no synchronous log read. With the view failing or hung, the list answers at once
  through the old read. The off switch works.
- **E2E:** `tests/e2e/conversation-list-log-view-alive.test.ts`. Through the production
  constructor, the list for N topics does zero log reads once the view is ready, and answers before
  it is.

## Rollback

Set `telegramHistoryView.enabled: false`, or revert. There is no persistent state.
