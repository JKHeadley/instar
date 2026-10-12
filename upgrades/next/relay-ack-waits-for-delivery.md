# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The relay's automatic ack ("Message received. Composing response...") was held until routing finished only for replies on topic-bound threads (#2174). For every other inbound message, such as the first message on a new thread, it was still sent before routing, so a hand-off that reached no live session left the peer with a promise of a reply and then nothing. Now:

- The relay handler defers its own ack for every inbound message (`deferSend: true`) and settles it once, at the exit it takes, through the new `createRelayAckSettler` in `src/threadline/autoAck.ts`.
- The promising ack is sent only when a live consumer has the message: a pipe session was created (`pipe-spawned`) or `ThreadlineRouter` reported `delivered === true` (`router-delivered`: cold spawn, resumed or warm session, topic session).
- A message the warrants-reply gate suppresses (a no-reply verdict or an exhausted loop budget) gets the non-promising `Message received.` on every thread.
- No ack is sent when the router reports the message undelivered (refused, queued, failed), or when the message was only appended to the warm-listener inbox file: that write succeeds whether or not anything reads the file, so it is treated as a queue write, not a delivery. The server logs `Auto-ack withheld` with the reason.
- The per-sender ack rate limiter is now charged only for an ack that is actually due.
- CLAUDE.md template and `migrateClaudeMd` gain a short "A2A ack waits for a live session" section (framework-shadowed). `docs/specs/a2a-ack-never-acked.md` gains Design §6 with the outcome table.

## What to Tell Your User

When another agent messages me, it is now told "composing a response" only once one of my running sessions really has the message. Before, it could be told that and then hear nothing, because the message never reached a session. If I decide a message needs no answer, the other agent gets a plain "received". If nothing picked the message up, it gets no receipt, so its own records show the message as still unacknowledged.

## Summary of New Capabilities

- The "message received, composing response" acknowledgement between agents is sent only after a running session has the message, on every kind of conversation.
- A message that reached no running session is no longer acknowledged, so the sender can see it was not picked up.

## Evidence

- Unit: `tests/unit/threadline/autoAck.test.ts` (every outcome of the settler on both sides: pipe, listener, router delivered and undelivered, no-reply; one-shot; the four send conditions; the rate limiter is not charged for a withheld ack) and `tests/unit/threadline/ack-stage-wiring.test.ts` (the real handler cut at every `return;`: each routed exit settles exactly once, the inbound-ack exit never does).
- Integration: `tests/integration/threadline/relay-ack-waits-for-delivery.test.ts` (a first message on a new thread through the real `ThreadlineRouter` — spawned, denied, queued — the real `ListenerSessionManager` inbox with no reader, and the real `ThreadlineClient` wire encoding); `tests/integration/threadline/ack-never-acked.test.ts` still passes on the updated shared composition.
- E2E: `tests/e2e/threadline/ack-never-acked-alive.test.ts` (over a real relay: a message that reaches no live session leaves the sender's record `awaiting-ack` and puts no frame on the wire; the next, delivered, is acked on its own thread).
- Migration parity: `tests/unit/PostUpdateMigrator-a2aAckWaitsForDelivery.test.ts`, `tests/unit/feature-delivery-completeness.test.ts`.
