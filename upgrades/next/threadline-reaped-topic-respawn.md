# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A Threadline reply on a thread bound to a Telegram topic whose session had been idle-reaped was lost (ACT-091): the relay sent the automatic "Message received. Composing response..." ack before routing, `TopicLinkageHandler` took the "session registered but not alive" branch, set `resume-pending` and spawned nothing, and `ThreadlineRouter` returned `resumed: true`, so the relay logged "Resumed session" for a message that reached no session. Now:

- `TopicLinkageHandler` gains an optional `respawnTopicSession` dependency. When no live session holds the topic it respawns the topic's session with the reply as its first message, through a new module hook `_threadlineTopicRespawn` set inside `wireTelegramRouting`: the same `respawnSessionForTopic` path (with `--resume`) an inbound Telegram message uses, after the same checks the Telegram dead-session path runs (ownership re-check, G3 lease gate, `classifySessionDeath` — no respawn after a quota death, fresh start after context exhaustion — SpawnAdmission with a new journal-only callsite `threadline-topic-respawn`, and the `spawningTopics` guard), awaited through the initial injection. The new delivery mode is `respawn-inject`; a refused or failed respawn is `failure-visible` (always surfaced in the topic).
- A reply arriving while the topic is already respawning (a second message from the peer, or a user message's respawn) waits for that spawn (bounded at 150 s) and is then typed into the live session once — never surfaced as `spawn-in-progress` unless the spawn is wedged. The handler routes through the hook whenever a spawn is in flight (`isTopicSpawning`), so a booting session is never pasted into directly. A live paste made by the hook is reported as `live-inject`.
- `ThreadlineRouter` reports `delivered`/`resumed` only for `live-inject` and `respawn-inject`, and logs the real delivery mode. `resume-pending` is no longer reported as resumed. Its per-thread spawn guard (`pendingSpawns`) no longer refuses a topic-linked reply that arrives while the first one's respawn is being awaited — the topic path serializes on the topic's spawn guard; the thread guard is taken only on fall-through to the thread-worker path.
- The relay handler defers its own ack for topic-bound replies (`runRelayAckStage` `deferSend`) and sends it through the new `settleDeferredRelayAck` only when routing delivered to a live session; otherwise it logs `Auto-ack withheld`. A topic-bound reply the warrants-reply gate suppresses gets the non-promising ack `Message received.` (`NO_REPLY_ACK_MESSAGE`), so the sender's delivery tracker records it as received rather than reporting a stuck channel. It also logs `accepted but not delivered to a live session` for undelivered results.
- CLAUDE.md template and `migrateClaudeMd` gain a short "A2A reply into a reaped topic session" section (framework-shadowed).

## What to Tell Your User

When another agent replies to a conversation that started in one of your topics, and that topic had gone quiet and been shut down, the reply now wakes the topic up and I pick it straight back up. Before, those replies could silently go missing while the other agent was told I was writing back.

## Summary of New Capabilities

- Agent-to-agent replies on a topic whose session was shut down for idleness now restart that session with the reply, instead of being lost.
- The "message received, composing response" acknowledgement is only sent once a running session actually has the message.

## Evidence

- New: `tests/unit/threadline/topicRespawnHook.test.ts` (every branch of the decision; a second reply during an in-flight spawn waits and is typed in exactly once; a wedged spawn past the bound surfaces), `SpawningTopicsRegistry.waitUntilClear` cases in `tests/unit/spawningTopicsRegistry.test.ts`, `tests/unit/threadline/TopicLinkageHandler-reaped-respawn.test.ts` (alive → live-inject, respawn never called; reaped → respawn-inject; refused/throws → failure-visible and surfaced), `tests/integration/threadline/topic-reaped-session-respawn.test.ts` (real router + real handler: delivered/resumed/path topic on respawn; not delivered, not resumed on refusal and on legacy resume-pending; live path untouched; two replies inside one respawn through the real registry + real hook: one respawn, one live paste, nothing lost or duplicated), `tests/e2e/threadline/topic-reaped-respawn-wiring.test.ts` (server.ts wires the hook to the Telegram respawn path), deferred-ack cases in `tests/unit/threadline/autoAck.test.ts` and `tests/unit/threadline/ack-stage-wiring.test.ts`, `tests/unit/PostUpdateMigrator-a2aReapedTopicRespawn.test.ts`. Every ACT-091 case fails with the `src/` change reverted.
