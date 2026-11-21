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

- **The view.** `TelegramAdapter` keeps a view of the log file: the newest 500 rows per topic,
  exactly as a file read parses them.
  - **Build:** one pass of small awaited reads, single flight, started in the background (at
    server start where the app is on, and by a list request when the view is not ready). It reads
    to the end of the file and publishes in the same turn that confirms the same file and size, so
    no save falls between.
  - **Kept current:** each successful save adds its row in persisted JSON shape.
  - **Dropped and rebuilt** after a trim, a failed save (which may have written part of a line), or
    a save onto a torn last line.
  - **A failed build** publishes nothing; the next list request may start another after 5 s,
    doubling to 5 min.
- **The only reader.** `getTopicHistoryForList(topicId, limit)` is the only reader of the view. It
  is used by the list producer and by the unread source's Telegram history (unread counts, the unread
  divider, read-mark resolution). It is `getTopicHistory` with one difference: when the view is
  ready, the tail-cache seed and the per-topic scan read the view instead of the file. When the view
  is not ready (building, failed, or switched off), it runs the old `getTopicHistory` immediately.
  Every failure path is therefore the old code's by construction.
- **Off switch.** `telegramHistoryView.enabled: false` (default on; read live through LiveConfig
  where available) returns the list to the old read with no code change, and drops the view.
- **Trim.** Both save paths keep the old trim code byte for byte. The only addition is a notice
  after a successful trim that drops and rebuilds the view: `noteLogRotated()` in `maybeRotateLog`,
  and an `onRotated` callback in `MessageLogger`.

## Decision points touched

No gate, filter, block or allow decision is added, removed or changed.

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
