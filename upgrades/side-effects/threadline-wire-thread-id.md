# Side-Effects Review — a relay send reports the conversation id the peer will reply on

**Version / slug:** `threadline-wire-thread-id`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

ACT-1304 (reported by Luna/sagemind on Threadline, 2026-10-04). On the relay path of `POST /threadline/relay-send`, a send without an explicit `threadId` let `ThreadlineClient` pick the wire thread (client affinity or a fresh `thread-<ts>-<rand>`), but the route recorded `threadId ?? messageId`. Every downstream record — the canonical outbox, the thread log, the Telegram bridge mirror, the A2A delivery tracker, the reply waiter, and `captureOrigin` (the thread→origin-topic binding that routes a reply back to the session that asked) — was keyed on the `msg-…` id. The peer replied on `thread-…`, which matched none of them, so the reply cold-spawned a new session; at a full session cap that spawn was refused and the queued reply was held indefinitely.

`ThreadlineClient.sendAutoWithThread` returns `{ messageId, threadId }` where `threadId` is the id that went on the wire (both the encrypted `send` and plaintext `sendPlaintext` paths record it). The route uses it for every record above. Wire behaviour is unchanged.

## Decision-point inventory

None changed. Routing of an inbound reply (topic linkage / live inject / resume / spawn) is unchanged; it now receives the correct key.

## 1. Over-block

Nothing is refused.

## 2. Under-block

ACT-1304's other parts are not in this change: the spawn drain's give-up alert being held by the origin and duplicate-content gates, and a reported thread id truncated at its last hyphen (no cause located yet). A reply to a send from a session that is NOT topic-bound has no origin binding, so it still takes the spawn path (as before). <!-- tracked: ACT-1304 -->

## 3. Level-of-abstraction fit

The client is the only place that knows the wire thread; it now reports it. The route stops guessing.

## 4. Signal vs authority compliance

No authority added.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

The local-delivery path already used the minted `effectiveThreadId` and is untouched. Threads recorded before this change under `msg-…` ids keep those records; new sends use the wire id. Callers that pass an explicit `threadId` see no difference. Test mocks of the relay client gained `sendAutoWithThread`. Side benefit: the A2A delivery tracker acknowledges by thread id, so relay sends' `stale` flag becomes accurate (a `msg-…` key could never be acked by a reply). The stored-retry path re-sends old records with their recorded `msg-…` thread id, behaving as before.

## 6. External surfaces

`threadline_send`'s returned `threadId` is now the real conversation id (previously the message id on relay sends). `threadline_history` on that id now finds the thread.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local send path; the corrected id flows into the same replicated/mesh records as before (thread log, conversation mesh view), now consistent with the peer's.

## 8. Rollback cost

Revert; no data migration. Records written with wire ids remain valid.

## Conclusion

A one-field correctness fix at the source of the mismatch, which lets the existing reply-to-originator path work for relay sends.

## Second-pass review (if required)

Independent subagent reviewer, 2026-10-05: **Concur with the review.** Both send paths always put a thread id on the wire and the receiver keeps an arriving id (it mints only when none arrives); the anti-hijack isolation fires only for an id owned by a different participant, which a fresh `thread-…` id cannot be. No consumer relies on threadId===messageId; the delivery tracker and reply waiter key on thread id. `lastWireThreadId` is set and read synchronously. Two notes folded into §5. A pre-existing window where a very fast reply could beat the waiter registration (after `await captureOrigin`) is unchanged by this change.
