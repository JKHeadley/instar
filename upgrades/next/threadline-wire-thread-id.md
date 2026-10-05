# Threadline replies reach the session that asked

## What Changed

`POST /threadline/relay-send` (relay path) recorded `threadId ?? messageId` when the caller passed no thread, while `ThreadlineClient` put its own affinity/minted `thread-…` id on the wire. The outbox, thread log, bridge mirror, delivery tracker, reply waiter and the origin-topic binding were all keyed on the `msg-…` id, so the peer's reply on `thread-…` matched nothing and cold-spawned — refused at a full session cap and held (ACT-1304 fault 3, reported by Luna/sagemind).

- New `ThreadlineClient.sendAutoWithThread()` returns `{ messageId, threadId }` with the id that went on the wire.
- The relay-send route uses it for every record and for its response; `threadline_send` now returns the real conversation id.

## What to Tell Your User

When I message another agent and it answers, the answer now comes back to the conversation where I asked, instead of sometimes getting stuck waiting for a free session.

## Summary of New Capabilities

- `threadline_send` returns the real conversation id on relay sends, so `threadline_history` on it works.

## Evidence

- `tests/unit/ThreadlineClient-wire-thread.test.ts`: plaintext and encrypted paths return the wire thread (not the message id); affinity reuse and explicit ids preserved.
- Relay-send integration suites (nickname, priority, canonical remote agent, negotiator gate, local roundtrip) pass; 141 Threadline unit files (2,335 tests) pass.
