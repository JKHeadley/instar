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

## Active recovery: the redelivery sentinel

Built on the tracker's `findOverdue` work-list, `monitoring/A2ARedeliverySentinel` is the
active-recovery layer. On a cadence it sweeps overdue (unacknowledged) messages and, for each one
still under the attempt cap, re-sends it with exponential backoff — recovering the original body
from the canonical outbox by message id. Once a message exhausts its attempts, the sentinel raises
**one aggregated attention item per dark peer** (never one per message), so a peer that has gone
offline or unreachable surfaces to the operator instead of failing silently.

It is recording-and-sending only — it holds no blocking authority and never alters a live send.
Ships **off** by default (it re-sends and escalates); enable via
`monitoring.a2aRedelivery.enabled` in `.instar/config.json`. The escalate-once guarantee is
structural: a message marked escalated leaves the `findOverdue` work-list, so it is never
re-escalated.
