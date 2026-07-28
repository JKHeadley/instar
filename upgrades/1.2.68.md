# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

Phase 1 of the Threadline re-assessment — the **conversation keystone**. It fixes
the two failures we hit live: agent-to-agent threads fragmenting into stray
side-sessions, and two agents echoing acknowledgements at each other forever (the
echo↔codey ~20-minute ping-pong on 2026-05-24).

**The root cause.** Every inbound Threadline message spawned a fresh, memory-less
worker whose prompt always said "reply." Nothing owned the turn count, so an
amnesiac worker reflexively volleyed acks; and the conversation→topic binding was
captured *outbound by willpower* (a caller had to stamp `originTopicId`), so when
it was forgotten the thread floated into a new untied session.

**The fix (three parts).**
1. **A single Conversation record** (`ConversationStore`) is now the home for a
   thread's turn count, novelty hashes, binding and lifecycle — the one place the
   one-shot worker provably can't keep, but the gate needs. Every write goes
   through a single-writer CAS surface (modeled on `CommitmentTracker.mutate`) so
   concurrent inbound messages can't clobber the turn count.
2. **A warrants-a-reply gate** runs once at the relay inbound funnel, upstream of
   all three routing branches (pipe-spawn / warm-listener / cold-spawn), so a
   no-reply verdict short-circuits all of them. Questions, imperatives and
   decisive control tokens always get a reply; a content-free ack does not; a
   novelty-gated turn budget winds down a circular exchange while a genuinely
   novel long collaboration never trips it; a human in the thread is always
   answered instantly.
3. **Structural session/topic binding.** The origin session name is injected at
   the spawn boundary (`INSTAR_SESSION_NAME`), forwarded on the send, and
   resolved to the owning topic server-side — so a conversation sticks to its
   session/topic without anyone remembering to tag it.

Plus an anti-hijack fix found while wiring it: a threadId is not a bearer token —
an unverified peer presenting someone else's threadId is now isolated to a fresh
first-contact thread instead of being injected into the owner's session.

## What to Tell Your User

- Agents no longer loop on "thanks → thanks." A bare acknowledgement doesn't
  trigger a reply, and a back-and-forth that stops making progress winds down on
  its own — but a real question or request is always answered, and if you're in
  the conversation it stays instant.
- A conversation now stays glued to the right place automatically; it won't spin
  off into a stray parallel session anymore.
- Nothing to configure. Existing in-flight conversations are migrated over on
  update so they keep their context.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation single-source-of-truth (`ConversationStore`) | Automatic; backs the loop gate's turn/novelty state at `.instar/threadline/conversations.json` |
| Warrants-a-reply loop gate | Automatic at the relay inbound funnel; budget exhaustion escalates ONE attention item (never silently drops) |
| Structural session/topic binding | Automatic via `INSTAR_SESSION_NAME` — no caller needs to stamp `originTopicId` |
| Anti-hijack resume guard | Automatic; unverified threadId-mismatch → isolated fresh thread |

## Migration Notes

`PostUpdateMigrator.migrateThreadlineConversationStore` folds the legacy
`thread-resume-map.json` + `context-thread-map.json` into `conversations.json` on
update — idempotent, field-preserving (`sessionUuid`, `agentIdentity`, `pinned`,
`failed`/`archived`, cross-machine, `boundTopicId`), and it never clobbers a
runtime-written row. No `~/.codex` or relay change.

The full physical collapse of `ThreadResumeMap`/`ContextThreadMap` into the single
store (so the router reads/writes *only* the Conversation) is intentionally NOT in
this release: those stores are written from two processes (the server and the MCP
stdio child), so a single in-memory store needs the child to route writes through
the server first — tracked as **CMT-497**, folding into the Phase 2 server-owned
reply model (CMT-493). Phase 1 ships the loop/fragmentation/hijack fixes with the
Conversation as the authoritative turn/novelty/binding store.

## Evidence

- Spec: `docs/specs/THREADLINE-CONVERSATION-KEYSTONE-SPEC.md` (+ ELI16 companion,
  + convergence report — 2 fatal + 4 blocking findings fixed before code).
- Tests (4 tiers): `ConversationStore.test.ts` (14, incl. 50-concurrent-increment
  CAS race), `WarrantsReplyGate.test.ts` (18, both sides of every boundary),
  `ThreadlineRouter-anti-hijack.test.ts` (3), `PostUpdateMigrator-conversationStore.test.ts`
  (5, field preservation + idempotency), integration `warrants-reply-funnel.test.ts`
  (5, incl. the echo↔codey loop-termination reproduction + CAS integrity under
  concurrency), and wiring-integrity `conversation-keystone-wiring.test.ts` (6,
  feature-alive: constructed + invoked + upstream of all branches).
- A loop-gate bug the integration test caught that unit tests missed: keying
  "first contact" off `turnCount===0` made every post-progress turn reply, since
  turnCount resets to 0 on novelty — fixed to key off conversation history.

## Rollback

Additive. The Conversation store is new; the gate is a guarded early-return at the
funnel; the binding is a launch-time computation. Revert = remove the funnel gate
block + the `INSTAR_SESSION_NAME` injection + the migration call. No persistent
state to clean up (the legacy stores are left intact by the migration).
