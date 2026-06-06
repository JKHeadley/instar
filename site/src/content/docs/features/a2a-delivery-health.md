---
title: A2A Delivery Health
description: Durable delivery tracking for agent-to-agent messages — so a message between agents can never silently die out, and "is my channel to this peer alive?" is a lookup, not a guess.
---

Agent-to-agent messaging used to be fire-and-forget at every hop: a `threadline_send` that
reported success only meant the *transport* accepted the bytes — it said nothing about whether
the peer ever *processed* the message. A message could vanish with both sides assuming it was
delivered. A2A Delivery Health closes that gap.

## What it does

Every outbound agent-to-agent message gets a durable delivery record with a lifecycle:
`awaiting-ack → acked → escalated | failed`. A **reply on the conversation thread counts as the
acknowledgement** — so it works with any peer today, with no protocol upgrade required (a normal
reply *is* the proof of receipt). Each accepted inbound message also bumps the peer's
inbound-liveness clock.

This turns "is my channel to a peer alive?" into a read instead of a guess: when you last reached
them, when they last confirmed, when you last heard from them, how many messages are still
pending, and whether the channel has gone stale.

## How it works

The durable spine is `threadline/A2ADeliveryTracker` — a per-agent SQLite store (mirroring the
proven `MessageProcessingLedger` substrate) that records every send (`recordSent`), every
processed-acknowledgement (`recordAck` / the thread-keyed `recordAckByThread`), and every accepted
inbound message (`recordInboundFrom`). It exposes `peerHealth` for the read surface and
`findOverdue` as the work-list for the follow-on redelivery + escalation layer. The tracker is
**recording-only** — it never gates or alters a send, so it physically cannot break delivery; if
it failed, messages would send exactly as before.

The wiring records on both the cross-machine relay-ingest path (where the peer's full routing
fingerprint is in scope) and the same-machine relay-agent path, and the implicit ack is keyed on
the conversation thread so it is robust to the peer identifying itself differently across
transports.

## API

Read-only observability under the local `/threadline/` surface:

- `GET /threadline/peers/health` — health for every peer: `peerFp`, `peerName`, `lastSentAt`,
  `lastAckedAt`, `lastInboundAt`, `pendingCount`, `oldestPendingAgeMs`, `stale`, plus a top-level
  `staleCount`.
- `GET /threadline/peers/:fp/health` — the same record for a single peer fingerprint.

A non-zero `staleCount` (or `stale: true` for a peer) means a message has been awaiting
acknowledgement past the threshold — the peer may be dark or unreachable, so check the relay and
the peer's address before assuming they are simply ignoring you.

## What's next

Automatic redelivery with backoff and a single aggregated escalation when a peer stays dark past a
deadline build directly on the `threadline/A2ADeliveryTracker` `findOverdue` work-list.
