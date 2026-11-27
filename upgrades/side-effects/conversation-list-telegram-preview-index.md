# Conversation list Telegram preview index side effects

## Decision and authority

No authority or visibility change: the list still shows exactly the topics getAllTopicMappings returns; only where each preview's last entry comes from changes. AgentServer's conversation-list telegramTopics now calls TelegramAdapter.latestTopicEntries once for all mappings. That answers a topic in the tail cache from it, otherwise from a background newest-entry index; until the index exists the answer is unknown and the preview is blank (lastActivity null, lastPreview null). The adapter starts the build on start(); a request that finds it missing also starts it. While any preview is unknown the Telegram rows carry partial: true, and localConversationListPage marks the page partial, so every topic is still listed but no reader (the conversation graph source inventory shares this list) records a missing preview as no activity. An adapter without the method (test doubles) keeps the old per-topic getTopicHistory call.

## Data and resource effects

Memory: one LogEntry per topic in the log (574 topics on the Laptop). The build reads the log once per process with async 1 MB reads and a setImmediate yield per chunk, parsing each complete line; malformed lines are skipped. Entries logged during the build are held in a pending map and applied over the result, and later appends update the index in rememberLoggedEntry. A failed build is logged and retried on the next request. Visible effect: right after a start, list ordering by last activity may place not-yet-indexed topics as having no activity until the build completes. No stored data or format changes; nothing else reads the index.

## Rollback and verification

Revert the AgentServer call and the TelegramAdapter additions. Verification: tests/unit/conversation-list-telegram-partial.test.ts (every topic listed and the page partial while previews are unknown, complete once known) and tests/unit/telegram-latest-topic-entries.test.ts (unknown before the build with no log read on the request, newest entry per topic after, channelId rows, malformed lines, empty topics, appends during and after the build, missing log, and a heartbeat over a generated 30 MB log: largest event-loop gap 5.6 ms on the M5). Existing TelegramAdapter unit files (tail cache, adapter, history-before: 29 tests) pass unchanged.

## Review

Machine fix per the Chief of Staff (2026-11-27 06:09 PT), kept small as Project Alignment asked; the other staged history fixes follow separately.

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author (Parity session, 2026-11-27 06:13-06:16 PT)

Verdict CONCUR WITH CHANGES, applied before commit: (1) the conversation graph source inventory reuses this list and would have recorded no activity for every not-yet-indexed topic on a page not marked partial; now the Telegram rows carry partial and the page is marked partial; (2) the first list after a start sorted cold topics last and a cursor crossing the build's end could skip rows; the build now starts from start(), and the partial flag makes the remaining window explicit; (5) the new methods were moved above getTopicHistory's doc comment. Confirmed: both append paths call rememberLoggedEntry only after a successful write; channelId rows, chunk splits at newline bytes and a final line without newline are handled; rotation (temp file plus rename) cannot make the index stale; the tail and the index update together, so preferring the tail never returns an older entry; concurrent build calls share one promise. Follow-up noted, not in this change: getTopicHistory(topicId, 500) in AgentServer search and event paths still resolves one cold topic with a synchronous read.

## 6b. Operator-surface quality

Blank last-activity preview for not-yet-indexed topics for about a second after start, instead of a list that does not load for tens of seconds.

## Framework generality

Telegram adapter and the conversation list only; no agent framework or model provider involved.
