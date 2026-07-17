---
title: Telegram Local Ingest Deduplication
status: approved
date: 2026-07-16
parent_principle: durable-conversation-identity
---

# Telegram Local Ingest Deduplication

## Scope

This is the local single-machine message-log axis. It is distinct from remote owner delivery and cross-machine receipt deduplication.

## Invariant

One Telegram platform event produces at most one canonical local message-log row and one downstream message-logged notification. The identity key is direction, topic, and Telegram message ID. Repeated processing of the same event, including processing after an adapter restart, is a no-op at the append seam.

## Settlement order

The canonical JSONL append happens before the identity is remembered in memory. A failed append remains retryable. After a successful append, the tail cache, content version, TopicMemory callback, and event bus advance exactly once.

## Restart and redelivery

On first append, the adapter seeds its identity set from the bounded canonical JSONL. This covers local duplicate polling and the retained-offset path where a rejected forward causes Telegram to redeliver an earlier batch. Remote owner receipts remain a separate injection gate and are not relied upon to protect the local log.

## Compatibility

Both the legacy Telegram writer and the feature-flagged shared MessageLogger obey the same append result. Gross log format and message identifiers do not change.
