# Side-Effects Review — A2A Redelivery + Dark-Peer Escalation Sentinel (PR2)

**Version / slug:** `a2a-redelivery-escalation`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `self-review (modeled 1:1 on the reviewed CollaborationRedriveEngine; redeliver path covered by a real-outbox wiring-integrity test)`

## Summary of the change

Adds the active-recovery layer of "communications never just die out"
(A2A-DURABLE-DELIVERY-SPEC §4, issue #939, CMT-1143, PR2 — building on PR1's
`A2ADeliveryTracker`, shipped in v1.3.386). `src/monitoring/A2ARedeliverySentinel.ts`
sweeps the tracker's `findOverdue` work-list on a cadence: re-sends each overdue
(unacknowledged) message under the attempt cap with exponential backoff, and once
attempts are exhausted raises ONE aggregated attention item per dark peer. Wired in
`server.ts` (mirroring the `CollaborationRedriveEngine` block) with a `redeliver` fn
that recovers the message body from the canonical outbox (new
`ListenerSessionManager.readCanonicalOutboxEntry`) and re-emits via the relay client,
and `raiseAttention` → `TelegramAdapter.createAttentionItem`. New config
`monitoring.a2aRedelivery` (ships OFF). Files: `src/monitoring/A2ARedeliverySentinel.ts`,
`src/threadline/ListenerSessionManager.ts`, `src/commands/server.ts`, `src/core/types.ts`,
+ 2 test files + docs.

Scope note: this PR ships §4 (redelivery + escalation sentinel). The explicit
`a2a-ack` control message (spec §3 "Layer B") remains a follow-on — the implicit
ack-via-reply (PR1) plus this sentinel's redelivery+escalation already cover the
no-reply case, so the explicit control message is a lower-priority optimization. <!-- tracked: #939 -->

## Decision-point inventory

- `A2ARedeliverySentinel` — add — a SIGNAL CONSUMER: it re-sends (via the relay) and
  escalates (via the Attention queue). It holds NO blocking authority — never gates a
  send or receive. Escalate-once is structural (markEscalated removes a row from
  `findOverdue`).
- `readCanonicalOutboxEntry` — add — pure read helper (no decision surface).

## 1. Over-block

No block/allow surface — over-block not applicable. The sentinel only re-attempts and
escalates; it cannot reject anything.

## 2. Under-block

No block/allow surface. Coverage note: redelivery counts an attempt whether or not the
transport "accepted" (an accepted send still isn't an ack), so the retry clock always
advances toward escalation — a perpetually-accepted-but-never-acked message still
escalates rather than retrying forever.

## 3. Level-of-abstraction fit

Correct. A signal CONSUMER of the PR1 tracker's `findOverdue`, feeding existing
surfaces (relay client, Attention queue) — it re-implements neither. Modeled on the
reviewed `CollaborationRedriveEngine` (same injected-deps, per-tick caps,
setInterval+unref, ship-OFF shape). The message body is recovered from the existing
canonical outbox (not duplicated into the tracker).

## 4. Signal vs authority compliance

- [x] No — this change produces re-sends + an aggregated signal (attention item); it
  holds no block/allow authority. Brittle-free: all logic is deterministic state
  transitions over the durable tracker.

## 5. Interactions

- **Shadowing:** none. The sentinel runs on its own interval, independent of the
  send/receive paths.
- **Double-fire:** escalate-once is structural (`markEscalated` → row leaves
  `findOverdue`); a redelivered message stays `awaiting-ack` and is naturally re-acked
  by the peer's reply (PR1 implicit-ack) or re-swept. `maxRedrivesPerTick` caps load on
  a degraded relay. The implicit-ack-via-reply (PR1) and this sentinel cooperate: a
  reply acks-by-thread and removes the message from `findOverdue`, stopping redelivery.
- **Races:** the tracker is SQLite (WAL); the sentinel reads/writes rows independently.
  The outbox reader is read-only.
- **Feedback loops:** none — a re-send does not itself create a new tracked message
  (recordSent is only called on the original relay-send path, not here).

## 6. External surfaces

- **Other agents:** a redelivery re-sends a previously-sent message to the SAME peer on
  the SAME thread — idempotent at the peer (same messageId via relay). No new message
  content is invented.
- **Install base:** new `monitoring.a2aRedelivery` config (OFF by default → no behavior
  change for existing agents until enabled). New site/README docs.
- **Persistent state:** none new (uses PR1's SQLite tracker + the existing canonical
  outbox file). No PostUpdateMigrator step.
- **Attention queue:** ONE aggregated item per dark peer per escalation (P17-compliant);
  never one-per-message.

## 7. Rollback cost

Pure additive. Ships OFF (`monitoring.a2aRedelivery.enabled` absent/false → sentinel
not armed). Back-out = revert the commit + patch. No persistent-state cleanup; no
user-visible regression (the sentinel is inert until explicitly enabled).

## Conclusion

A signal-consuming recovery sentinel built on PR1's durable tracker, modeled 1:1 on the
already-reviewed `CollaborationRedriveEngine`, ship-OFF, with the redeliver wiring
(outbox-body recovery → relay re-send) proven by a real-outbox wiring-integrity test and
escalate-once guaranteed structurally. The explicit `a2a-ack` control message is the
only remaining piece of the spec, intentionally deferred as a tracked follow-on.

## Evidence pointers

- Tier 1: `tests/unit/A2ARedeliverySentinel.test.ts` — 8 tests (disabled no-op,
  redelivery under cap, escalate-once at cap, per-peer aggregation P17, per-tick cap,
  swallowed transport error, escalate-only mode).
- Tier 2 wiring-integrity: `tests/integration/a2a-redelivery-wiring.test.ts` — 6 tests
  (`readCanonicalOutboxEntry` found/absent/newest-wins/malformed-skip; the redeliver
  path recovers a real outbox body and re-sends; body-missing → escalate, no fabrication).
- All 14 green; `tsc --noEmit` clean; no-silent-fallbacks 461≤461; docs-coverage green
  on merge-state (class 134/537, route 104/574).
