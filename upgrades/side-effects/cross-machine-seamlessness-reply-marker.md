# Side-Effects Review — Cross-Machine Seamlessness: reply-marker propagation (D-xmachine)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3a ("dual-medium reply_committed marker")

The cross-machine half of exactly-once. The same-machine dedup gate + no-loss recovery handle
one machine; this closes the window where, AFTER a handoff/failover, a provider redelivery of a
message the OLD holder already answered arrives at the NEW holder — whose ledger wouldn't know,
so it would re-answer. The holder now propagates a `reply_committed` marker to standby peers on
each commit; the standby applies it via `applyRemoteReplyMarker`, so the new holder's dedup gate
drops the redelivery. Still flag-gated dark (`multiMachine.exactlyOnceIngress`, default false).

## What changed
- `src/core/ReplyMarkerTransport.ts` — NEW. `broadcast(marker)` signs + POSTs
  {dedupeKey, platform, replyIdempotencyKey, epoch, topic} to each standby peer's
  `/api/message-marker` over the authenticated machine channel. NO encryption (the marker
  carries no conversation content — authentication only). No peers → reachable no-op. Never
  throws (best-effort; the dedup gate + provider redelivery are the backstop).
- `src/server/machineRoutes.ts` — `POST /api/message-marker` (machineAuth) + `onReplyMarker`
  ctx callback. Validates the marker shape; 503 when no receiver (exactly-once off).
- `src/server/AgentServer.ts` — `replyMarkerTransport?` + `onReplyMarker?` options → routeCtx /
  machineRoutes.
- `src/server/routes.ts` — RouteContext.replyMarkerTransport; the outbound commit at
  `/telegram/reply/:topicId` reads the just-committed `replyIdempotencyKey` from the ledger and
  fires `replyMarkerTransport.broadcast(...)` (fire-and-forget, after the local commit).
- `src/commands/server.ts` — constructs `ReplyMarkerTransport` (peer resolver = registry
  machines with a lastKnownUrl) ONLY when `exactlyOnceIngress` + coordinator.enabled; wires
  `onReplyMarker` → `messageLedger.applyRemoteReplyMarker`.

## Over-block / under-block
- The marker NEVER over-marks a fresh event: `applyRemoteReplyMarker` only sets reply_committed
  on an entry not already acted-on, and the dedupeKey is the same provider-stable id both
  machines compute — so a marker for event X can only dedup event X. The deterministic
  `replyIdempotencyKey` (hash(dedupeKey+index)) is identical on both machines.
- UNDER-propagate (a lost marker): best-effort — if the marker doesn't reach the standby, the
  provider's at-least-once redelivery + the standby's own ledger (once it catches up) still
  dedup; the residual is the documented single-duplicate Two-Generals floor, not a new failure.
- Signed channel: `/api/message-marker` requires machineAuth (unsigned → 401, proven in the e2e);
  the marker carries no secrets so no encryption is needed.

## Signal vs authority
- The transport propagates; the receiving ledger's `applyRemoteReplyMarker` is the authority on
  its own state (only promotes a not-yet-acted entry). The dedup gate remains the single drop authority.

## Interactions
- Fires AFTER the local `commitInboundReply` (the local guarantee never depends on propagation).
- Skipped for proxy/system sends (same guard as the commit) — a proxy message isn't a user reply.
- Peer resolver mirrors the live-tail/handoff resolvers (registry machines with lastKnownUrl,
  excludes self/revoked). Solo agent → no peers → no-op.

## Rollback cost
- Low. Flag default-off ⇒ transport not constructed, route 503s, no propagation. Revert = drop
  the transport + route + the broadcast call. No persisted schema.

## Tests
- `tests/unit/reply-marker-transport.test.ts` (3): no-peers no-op; signs + POSTs to each peer;
  resolves false (never throws) when all peers reject.
- `tests/e2e/reply-marker-cross-machine-e2e.test.ts` (2): a PEER-signed marker over real HTTP +
  machine-auth applies to the receiver's ledger, then a redelivery of that message is DEDUPED
  (already-replied) — the cross-machine guarantee end-to-end; + unsigned marker rejected (401).

## Completion status
- With D-dedup + D-noloss + D-xmachine, the exactly-once guarantee is COMPLETE in all dimensions
  (no-dup same+cross machine, no-loss on crash), all DARK behind the flag. Remaining before the
  flag flips: D3 (CONTINUATION resume verify) + the over-Telegram two-machine test-as-self (the
  live acceptance bar, needs the operator's machines).
