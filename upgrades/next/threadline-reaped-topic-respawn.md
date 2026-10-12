# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A Threadline reply on a thread bound to a Telegram topic whose session had been idle-reaped was lost (ACT-091): the relay sent the automatic "Message received. Composing response..." ack before routing, `TopicLinkageHandler` took the "session registered but not alive" branch, set `resume-pending` and spawned nothing, and `ThreadlineRouter` returned `resumed: true`, so the relay logged "Resumed session" for a message that reached no session. Now:

- `TopicLinkageHandler` gains an optional `respawnTopicSession` dependency. When no live session holds the topic it respawns the topic's session with the reply as its first message, through a new module hook `_threadlineTopicRespawn` set inside `wireTelegramRouting`: the same `respawnSessionForTopic` path (with `--resume`) an inbound Telegram message uses, after the same checks the Telegram dead-session path runs (ownership re-check, G3 lease gate, `classifySessionDeath` — no respawn after a quota death, fresh start after context exhaustion — SpawnAdmission with a new journal-only callsite `threadline-topic-respawn`, and the `spawningTopics` guard), awaited through the initial injection. The new delivery mode is `respawn-inject`; a refused or failed respawn is `failure-visible` (always surfaced in the topic).
- `ThreadlineRouter` reports `delivered`/`resumed` only for `live-inject` and `respawn-inject`, and logs the real delivery mode. `resume-pending` is no longer reported as resumed.
- The relay handler defers its own ack for topic-bound replies (`runRelayAckStage` `deferSend`) and sends it through the new `settleDeferredRelayAck` only when routing delivered to a live session; otherwise it logs `Auto-ack withheld`. It also logs `accepted but not delivered to a live session` for undelivered results.
- CLAUDE.md template and `migrateClaudeMd` gain a short "A2A reply into a reaped topic session" section (framework-shadowed).

## What to Tell Your User

When another agent replies to a conversation that started in one of your topics, and that topic had gone quiet and been shut down, the reply now wakes the topic up and I pick it straight back up. Before, those replies could silently go missing while the other agent was told I was writing back.

## Summary of New Capabilities

- Agent-to-agent replies on a topic whose session was shut down for idleness now restart that session with the reply, instead of being lost.
- The "message received, composing response" acknowledgement is only sent once a running session actually has the message.

## Evidence

- New: `tests/unit/threadline/TopicLinkageHandler-reaped-respawn.test.ts` (alive → live-inject, respawn never called; reaped → respawn-inject; refused/throws → failure-visible and surfaced), `tests/integration/threadline/topic-reaped-session-respawn.test.ts` (real router + real handler: delivered/resumed/path topic on respawn; not delivered, not resumed on refusal and on legacy resume-pending; live path untouched), `tests/e2e/threadline/topic-reaped-respawn-wiring.test.ts` (server.ts wires the hook to the Telegram respawn path), deferred-ack cases in `tests/unit/threadline/autoAck.test.ts` and `tests/unit/threadline/ack-stage-wiring.test.ts`, `tests/unit/PostUpdateMigrator-a2aReapedTopicRespawn.test.ts`. Every ACT-091 case fails with the `src/` change reverted.
