# Replies after restart keep their order or explain a delay

## What Changed

The legacy Telegram recovery queue now sends older pending replies first within a conversation. The current origin outbox checks durable delivery records after restart and explains held, failed, or uncertain replies in the conversation and Attention hub. A reply overtaken by a newer answer is labeled as earlier work. Replies confirmed at least five minutes after preparation are also explained.

## Evidence

The real November 3 incident records show one reply accepted 56 minutes after it was written and another expired with an unknown outcome. An oldest-first regression failed before the fix and passed after. Targeted unit and integration tests and TypeScript checks passed.

## What to Tell Your User

If a reply is delayed after a restart, you will get a plain notice. If Instar cannot confirm whether it reached you, it will say so and avoid sending a possible duplicate. Older queued replies are delivered first where the legacy queue is used.

## Summary of New Capabilities

Replies interrupted by a restart now have clearer order and delivery status.
