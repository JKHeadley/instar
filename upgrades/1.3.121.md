# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline session-completion demotion now writes the matched conversation
directly.**

The v1.3.120 UUID fallback correctly found real inbound Threadline worker
sessions by `SessionManager` UUID, but the demotion path re-entered the resume
guard through `onSessionEnd()`. That guard expects a resumable Claude/Codex
transcript JSONL, while live Threadline spawns persist the `SessionManager`
session id. The result was a misleading `demoted 1` log with the conversation
still left `active`.

Fix: `ThreadlineRouter.onSessionComplete()` now demotes from the already matched
conversation entry instead of re-reading through the resume guard. The existing
awaiting-reply skip still applies before any write.

## What to Tell Your User

Threadline worker threads now really retire when their spawned session is
stopped or completes. The previous release could log that it demoted a thread
without actually moving the conversation out of the active list.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Direct completion demotion | Automatic when a Threadline worker emits `sessionComplete` |
| Non-transcript SessionManager UUID support | Automatic for inbound Threadline spawns |

## Evidence

- **Regression:** `ThreadlineRouter.onSessionComplete()` demotes a UUID-matched
  active thread even when that UUID has no transcript JSONL.
- **Live canary basis:** v1.3.120 matched by UUID and logged `demoted 1`, but the
  persisted conversation stayed `active`; this patch fixes that write path.
