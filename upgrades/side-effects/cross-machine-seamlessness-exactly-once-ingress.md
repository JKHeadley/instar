# Side-Effects Review — Cross-Machine Seamlessness: exactly-once ingress gate (D, no-duplicate half)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3a (converged, approved)

Wires the MessageProcessingLedger into the live Telegram message path so a redelivered /
handoff-window-replayed inbound event is recognized and NOT answered twice. This is the
no-DUPLICATE-reply half of G3a. It ships DARK behind `multiMachine.exactlyOnceIngress`
(default false): when off, the message path is byte-for-byte unchanged.

## What changed
- `src/messaging/ingressDedup.ts` — NEW. `decideIngress(ledger, dedupeKey, opts)` → process | drop
  (records received → claims processing under the lease epoch; drops already-replied or
  in-flight-not-stuck; re-claims a fenced-holder's stuck entry). `commitInboundReply(...)` →
  reply_committed + cursor_advanced with the deterministic idempotency key. `dedupeKeyFor(...)`.
- `src/server/routes.ts` — INBOUND gate in `/internal/telegram-forward`, placed AFTER the
  sentinel intercept (emergency-stop/pause must never be deduped) and BEFORE routing: on a
  drop, returns `{ok:true,deduped:true}` without routing. OUTBOUND commit in
  `/telegram/reply/:topicId` after a successful `sendToTopic`: commits the topic's current
  inbound dedupeKey (skipped for proxy/system sends). Both FAIL-OPEN. Added `messageLedger` +
  `currentInboundByTopic` to RouteContext.
- `src/server/AgentServer.ts` — `messageLedger?` + `currentInboundByTopic?` options → routeCtx.
- `src/commands/server.ts` — constructs the ledger + per-topic map ONLY when
  `seamlessness.exactlyOnceIngress` (fail-open if open() throws → gate stays dark).
- `src/core/seamlessnessConfig.ts` + `src/core/types.ts` — `exactlyOnceIngress` flag (default false).
- `src/core/MultiMachineCoordinator.ts` — `getLeaseEpoch()` accessor (the ledger's fencing token).

## Over-block / under-block
- UNDER-block (the dangerous direction = a real message silently dropped): mitigated three ways.
  (1) The gate ONLY drops when the ledger shows the SAME dedupeKey already reply_committed/
  cursor_advanced, or processing-and-not-stuck — never a first-seen event. Proven both sides in
  ingress-dedup.test.ts + the integration test. (2) FAIL-OPEN: any ledger throw routes normally
  (tested). (3) Ships DARK (flag default false) — zero behavior change until a live test-as-self
  flips it on.
- OVER-block: a genuine NEW message is always `first-seen` → process. The dedupeKey is
  `telegram:<topic>:<messageId>`, unique per user message, so two distinct messages never collide.
- dedupeKey uses Telegram `message_id` (already on the forward, stable across redeliveries and
  across machines). The spec names `update_id`; message_id is the functional v1 key (gate falls
  back to it). update_id threading is a tracked refinement. <!-- tracked: topic-13481 -->

## Signal vs authority
- decideIngress returns a decision; the route is the single authority that drops/routes. The
  ledger is durable record + fencing, not a gate of its own.

## Interactions
- Placed after the sentinel intercept so "stop everything" is never deduped (wiring-integrity
  test asserts gate index is between classify and onTopicMessage).
- Outbound commit skipped for `isProxy` sends (PresenceProxy etc. are not replies to a user
  inbound) so it never falsely commits an unrelated topic.
- `currentInboundByTopic` is best-effort association (last claimed inbound per topic). Concurrent
  inbounds for one topic before the first reply → the earlier one stays processing (eventually
  reclaimable / replayed). Acceptable for v1, behind the flag.

## NOT in this increment (tracked, topic-13481)
- **No-LOSS-on-crash replay** (re-inject un-committed entries on restart) — the other G3a half.
  Without it, this increment is a strict IMPROVEMENT (adds dedup, no regression: a crash after
  inject-before-reply loses the reply exactly as today). Next increment.
- Cross-machine `applyRemoteReplyMarker` propagation (tunnel+git) — the lease already ensures one
  forwarder, so cross-machine double-handle is already prevented; this hardens the failover window.
- CONTINUATION resume verification (D3); update_id dedupeKey (vs message_id).

## Rollback cost
- Low. Flag default-off ⇒ inert in production. Revert = drop the gate block + commit block + the
  ledger construction; no migration, no persisted schema beyond the opt-in SQLite file. The route
  returns to identical behavior when `messageLedger` is null.

## Tests
- `tests/unit/ingress-dedup.test.ts` (8) — decision both sides: first-seen, in-flight drop,
  already-replied drop, stuck re-claim, within-window no-reclaim; commit idempotent + deterministic key.
- `tests/integration/exactly-once-ingress.test.ts` (5) — gate through the REAL route + REAL ledger:
  dark routes both, first routes + claims, in-flight dup dropped, already-replied dup dropped,
  fail-open; + wiring-integrity (gate between sentinel and routing).
- `tests/e2e/exactly-once-ingress-e2e.test.ts` (1) — gate ALIVE in a real booted AgentServer:
  already-replied redelivery → 200 + deduped over real HTTP, not routed.
