# Telegram local ingest deduplication

## What Changed

The Telegram message-log append seam now recognizes an already-persisted platform message and suppresses the duplicate row and duplicate downstream callbacks.

## Evidence

The focused Telegram polling and shared-logger suites pass 36 tests, including immediate replay, restart replay, and retained-offset batch redelivery. The build also passes.

## What to Tell Your User

One Telegram message now creates one local conversation-history row, even if Telegram delivers the same event again after a retry or restart.

## Summary of New Capabilities

Local Telegram history is idempotent across both logger implementations and across adapter restarts.
