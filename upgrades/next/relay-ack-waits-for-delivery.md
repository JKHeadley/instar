# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The relay's automatic ack ("Message received. Composing response...") was held until routing finished only for replies on topic-bound threads (#2174). For every other inbound message, such as the first message on a new thread, it was still sent before routing, so a hand-off that reached no live session left the peer with a promise of a reply and then nothing. Now:

- The relay handler defers its own ack for every inbound message (`deferSend: true`) and settles it once, at the exit it takes, through the new `createRelayAckSettler` in `src/threadline/autoAck.ts`.
- The promising ack is sent only when a live consumer has the message: a pipe session was created (`pipe-spawned`) or `ThreadlineRouter` reported `delivered === true` (`router-delivered`: cold spawn, resumed or warm session, topic session).
- A message the warrants-reply gate suppresses (a no-reply verdict or an exhausted loop budget) gets the non-promising `Message received.` on every thread.
- No ack is sent when the router reports the message undelivered (refused, queued, failed). The server logs `Auto-ack withheld` with the reason; a capacity refusal that `SpawnRequestManager` queued (for example `Session limit reached (5/5)`) is logged as "queued for a later session spawn", not as lost (`describeUndeliveredRouterResult`). No separate "received, queued" receipt is sent: the queue is in memory, bounded and expires after 10 minutes, and peers from before the `ack` wire type would route a new untyped text to a session.
- **A message loss is closed.** `ListenerSessionManager` reported `listening` from construction, so short messages (2000 characters or fewer) from `trusted`/`autonomous` senders on non-topic threads were appended to `state/listener-inbox-<rotation>.jsonl`. Nothing starts a listener session or reads that file, so the first ten such messages per server run were never consumed. The manager now starts in state `starting` and `shouldUseListener` returns false unless a reader heartbeat (`markReaderAlive`) is no older than `readerHeartbeatMaxAgeMs` (default 60 s); nothing calls `markReaderAlive` today, so these messages go to the router and a normal session. With a proven reader the hand-off gets the promising ack (`listener-delivered`); if the heartbeat goes stale between the check and the write it gets none (`listener-queued`).
- `/threadline/status` → `listener` gains `readerLive` and `lastReaderHeartbeatAt`; `active` is now false until a reader is proven.
- The per-sender ack rate limiter is now charged only for an ack that is actually due.
- CLAUDE.md template and `migrateClaudeMd` gain a short "A2A ack waits for a live session" section (framework-shadowed). `docs/specs/a2a-ack-never-acked.md` gains Design §6 with the outcome table.

## What to Tell Your User

When another agent messages me, it is now told "composing a response" only once one of my running sessions really has the message. Before, it could be told that and then hear nothing, because the message never reached a session. If I decide a message needs no answer, the other agent gets a plain "received". If nothing picked the message up, it gets no receipt, so its own records show the message as still unacknowledged. I also fixed a quiet loss: short messages from agents I trust could be put in a waiting file that nothing ever read. Those now reach a working session like any other message.

## Summary of New Capabilities

- The "message received, composing response" acknowledgement between agents is sent only after a running session has the message, on every kind of conversation.
- A message that reached no running session is no longer acknowledged, so the sender can see it was not picked up.
- Short messages from trusted agents are no longer dropped into an unread waiting file; they are handled by a session.

## Evidence

- Unit: `tests/unit/ListenerSessionManager.test.ts` (no reader at construction; `setState('listening')` is not a heartbeat; fresh at the bound, stale one ms past it; configurable bound; queue depth and reply claims unaffected). `tests/unit/threadline/autoAck.test.ts` (every outcome of the settler on both sides: pipe, listener, router delivered and undelivered, no-reply; one-shot; the four send conditions; the rate limiter is not charged for a withheld ack) and `tests/unit/threadline/ack-stage-wiring.test.ts` (the real handler cut at every `return;`: each routed exit settles exactly once, the inbound-ack exit never does).
- Integration: `tests/integration/threadline/relay-ack-waits-for-delivery.test.ts` (the real router over the real `SpawnRequestManager`: session limit reached → queued, no ack, logged as queued; a free slot → delivered and acked; refused with the queue full → not queued, no ack; a first message on a new thread through the real `ThreadlineRouter` — spawned, denied, queued — the real `ListenerSessionManager` (no proven reader → router path, inbox file never created; fresh heartbeat → listener path; stale heartbeat → router path), and the real `ThreadlineClient` wire encoding); `tests/integration/threadline/ack-never-acked.test.ts` still passes on the updated shared composition.
- E2E: `tests/e2e/threadline/ack-never-acked-alive.test.ts` (over a real relay: a message that reaches no live session leaves the sender's record `awaiting-ack` and puts no frame on the wire; the next, delivered, is acked on its own thread).
- Migration parity: `tests/unit/PostUpdateMigrator-a2aAckWaitsForDelivery.test.ts`, `tests/unit/feature-delivery-completeness.test.ts`.
