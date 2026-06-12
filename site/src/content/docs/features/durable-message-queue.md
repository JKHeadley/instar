---
title: Durable Inbound Message Queue
description: Crash-proof custody for undeliverable inbound messages, plus the hold-for-stability policy that stops pointless machine swaps.
---

When the multi-machine session pool's router can't deliver an inbound message
right now — its conversation is mid-move between machines, or the owning
machine is briefly unhealthy — the message takes **durable custody** in a small
on-disk SQLite queue instead of being injected into a possibly-stale local
session or silently dropped. A drain engine delivers it, in order, exactly when
the blockage clears.

The companion **hold-for-stability** policy gives a suspect-but-alive machine
up to 90 seconds (`holdMaxMs`) to recover before its conversation is moved to
another machine — so a 5-second network blip no longer causes a full
conversation house-move, while a genuinely dead machine (no heartbeat) still
fails over immediately.

**Ships dark.** Both layers default off (`multiMachine.sessionPool.inboundQueue`
ships `enabled: false, dryRun: true`; `holdForStability` trails one rollout
stage behind). Until enabled, message handling is byte-for-byte unchanged.

## Inspecting the queue

```bash
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/pool/queue
```

`GET /pool/queue` answers 503 while the feature is dark. When live (or in
dry-run) it reports:

- **Counts** — queued / claimed / held / frozen rows, plus `delivered24h`.
  Honesty contract: `delivered24h` **excludes** possibly-not-injected rows;
  those are summed separately as `deliveredUnconfirmed24h`, so the success
  number never overstates.
- **Durable counters** — including the dry-run promotion evidence
  (`wouldEnqueue`, `wouldHold`, `wouldRefuse`), `possiblyNotInjected`,
  `holdBypassedByAttemptsCap`, `orderingViolations`, and `mirrorDrift`.
- **Hold/flap state** — which machines are currently held against, and any
  machine flapping often enough that holds are disabled for it.
- **Tenure** — the queue's custody generation (advances on real
  holder changes, never on routine lease renewals).

## Loss is never silent

Every message the queue gives up on — TTL expiry, overflow eviction, an
operator stop, a pause that outlived its cumulative cap — produces one
plain-English notice naming what was lost ("I didn't get to these N messages —
resend anything still needed"). A "possibly not injected" notice means a crash
or send failure hit the one known razor-thin window between the delivery
receipt and the actual injection; if that message went unanswered, resend it.
Degradations in the queue's own machinery (a failing drain tick, a storage
error) surface through the standard degradation ledger at
`GET /health/degradations`.

## Troubleshooting delivery end to end

The queue is the *inbound* half of delivery robustness. When tracing a
missing or late message, read the durable surfaces in this order:

1. `GET /pool/queue` — is the message in custody (queued/held/frozen), and do
   the loss counters explain it?
2. `GET /pool/placement?topic=N` — which machine owns the conversation, and
   why (pinned vs placed)?
3. `GET /sessions/reap-log` — did the target session get shut down? Every
   session shutoff (and refused shutoff) is one JSON line here; a session
   never disappears without a trace. The live reaper view is
   `GET /sessions/reaper`, and its decision history is
   `GET /sessions/reaper/audit`.
4. `GET /delivery-queue` — the *outbound* relay queue (Telegram replies that
   failed to send and are being redriven). A reply that never arrived may be
   waiting here rather than anything being wrong inbound.

## Architecture (component map)

- **`PendingInboundStore`** — the SQLite custody store (`synchronous=FULL`,
  mode 0600): tri-state enqueue, atomic claims, injection receipts, tenure
  meta, cumulative pause accounting. Never exposes its DB handle.
- **`QueueDrainLoop`** — the policy engine: head-only per-session selection,
  hold verdicts, dispatch with deadlines and backoff, the backstop tick
  (declared Eternal Sentinel), halt/pause/wake handling.
- **`OwnerSuspectBreaker`** — the existing per-peer circuit breaker, extended
  with flap accounting: a machine flapping more than `flapThresholdPerHour`
  gets no holds at all until it calms.
- **`DeliverMessageHandler`** — the mesh receive side, extended with sender
  re-validation: a forwarded message whose stored sender is no longer
  authorized on the receiving machine gets a typed `sender-rejected` answer —
  never retried, never re-placed.
- The boot sweep runs on the unconditional startup path and settles whatever a
  crash left behind, per the spec's crash table. An operator emergency stop
  reaches custody through the same machinery that stops the session
  (`POST /autonomous/sessions/:topic/stop` and the message sentinel both
  settle the topic's queued rows).

## Safety properties (the short version)

- **At-most-once acting**: a delivery receipt is committed *before* injection,
  so a crash can duplicate a kickoff message in one narrow named window but can
  never replay a user instruction into a live session.
- **Emergency stop reaches custody**: a sentinel stop terminally settles the
  topic's queued rows (loss-reported) and a transactional fence aborts any
  in-flight handover — zero post-stop local injections.
- **Pause is a hold, not an abort**: pausing freezes only *queued* rows
  (in-flight deliveries complete), time spent frozen never counts against
  message TTLs, and cumulative pause time is capped.
- **Every repeating behavior carries brakes** (the No Unbounded Loops
  standard): backoff, circuit breakers, hard caps (50 per conversation, 500
  total, 30-minute shelf life), and an episode-latched, declared
  Eternal-Sentinel drain tick.
- **Config can't half-load**: six cross-knob timing invariants are validated at
  boot; any violation keeps the queue OFF for that boot with a loud,
  named error — never a half-configured queue.
