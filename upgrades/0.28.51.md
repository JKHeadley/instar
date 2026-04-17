# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Closes the compaction-recovery stall seen on topic 6795 (2026-04-17). When a session hit context compaction, `recoverCompactedSession` was deciding "is there pending work to re-inject?" by looking at the last message in the topic — without filtering out PresenceProxy standby messages (`🔭 …`) or server-emitted delivery/lifecycle acks (`✓ Delivered`, `Session respawned.`). Those messages are `fromUser: false` but they are NOT real agent responses. The recover helper treated them as "agent already answered," which caused it to decline three consecutive re-inject attempts while the user sat with an unanswered question for ~15 minutes.

The fix hoists the prefix classifier that `PresenceProxy.isSystemMessage()` and `checkLogForAgentResponse()` already used into a shared module (`src/messaging/shared/isSystemOrProxyMessage.ts`), adds a `findLastRealMessage(history)` walk-back helper on top, and routes `recoverCompactedSession` through it. Three scattered copies of the same prefix list — one of which was silently missing from the recovery path — are now one.

Secondary corrections: `recoverCompactedSession`'s history window widened from 5 to 20 entries so the walk-back has headroom past a run of standby/ack messages before it gives up; `checkLogForAgentResponse` now shares the classifier so any future addition to the prefix list (new system-emitted message format) lands in all three consumers for free.

Full side-effects review (over/under-block, abstraction fit, signal-vs-authority, interactions, rollback cost): `upgrades/side-effects/0.28.52.md`.

## What to Tell Your User

- **Compaction stalls recover cleanly now**: "When the agent's context window fills up mid-conversation, there's a safety net that re-asks me your question on the fresh session. It had a blind spot — if I'd posted a status-update like '🔭 working on it' before the context window filled up, the safety net thought I'd already answered you and stayed silent. That's fixed. The safety net now looks past status updates and delivery acks to find the real last message."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Compaction re-injection sees past PresenceProxy standbys and delivery acks | automatic — fires whenever CompactionSentinel detects a compaction event |

## Evidence

**Reproduction (pre-fix):** Topic 6795 on 2026-04-17 between 16:05 and 16:20. User sent "Please proceed here." at 16:05:22. CompactionSentinel detected context exhaustion at 16:08:14, 16:13:xx, and 16:18:xx. Each time, `recoverCompactedSession` logged `recoverFn declined (no pending work or session gone)` because the last message in `telegram.getTopicHistory(6795, 5)` was a PresenceProxy standby (`🔭 Echo is currently updating the ledger spec…`), not the user's question. Result: user saw no reply for ~15 minutes until manual intervention.

**Post-fix behavior:** `findLastRealMessage(history)` walks backward past the proxy standby and the `✓ Delivered` ack to find the user's question as the last real message; `recoverCompactedSession` returns `true` and re-injects `COMPACTION_RESUME_PROMPT`. The 25-test unit suite at `tests/unit/isSystemOrProxyMessage.test.ts` includes the exact topic-6795 sequence (user question → `🔭` proxy standby → `✓ Delivered` ack) asserting the walk-back returns the user question, not the ack.

**Live verification:** After shipping, simulated a compaction event on a topic whose most recent non-user messages are a PresenceProxy standby + delivery ack; confirmed `recoverCompactedSession` fires `direct re-inject OK for topic <N>` instead of the old `recoverFn declined` line. Logged in `.instar/shared-state.jsonl` under the `[CompactionResume]` tag.
