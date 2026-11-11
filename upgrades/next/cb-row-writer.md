<!-- bump: patch -->
## What Changed

Adds the channel-neutral TopicMemory row writer for the Context Budget work (`src/memory/topicRowWriter.ts`). Every channel's message rows now go through one key rule that every machine derives the same way: Telegram keeps its native id, Slack uses its message `ts` × 1e6, and app conversations use a stamp derived from the event itself. TopicMemory moves to schema v6 with two nullable columns (`channel_message_id`, `origin`) and a unique index on the channel id, added through the existing migration path. This fixes a Slack bug: every Slack message in a channel was stored under id 0, so the conversation memory kept one row per channel; each message is now its own row, and a person's Slack messages carry their user id. Rows mirrored in from another agent are labelled `relay` or `a2a`. App-conversation rows are written only when `contextBudget.enabled` is on. Slack file shares and messages you send to Slack from the Instar app get rows too, and app-conversation rows that were missed are replayed from the conversation store at boot and when the switch turns on (at most the 500 most recent per conversation). A key clash is refused and counted (a DegradationReporter row), never dropped silently, and a conversation whose channel has no row writer refuses to fold (`no-row-source`).

## What to Tell Your User

If you talk to me on Slack, I now remember each of your messages there on its own; before this, my searchable memory of a Slack conversation kept only its latest message. Nothing else changes for you.

## Summary of New Capabilities

- One row-key rule for Telegram, Slack and app conversations; Slack conversation memory keeps every message.
- TopicMemory rows record the channel's own message id and whether a row came from another agent.

## Evidence

- Unit `tests/unit/topic-row-writer.test.ts`; integration `tests/integration/topic-row-writer-channels.test.ts`; e2e `tests/e2e/topic-row-writer-lifecycle.test.ts`.
