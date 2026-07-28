# Side-Effects Review — Cross-Machine Seamlessness: G3 idempotent ledger + handoff lifecycle + adapter contract

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3a/G3e + Channel Seamlessness Contract (converged, approved)

## What changed
- `src/messaging/MessageProcessingLedger.ts` (new) — SQLite-backed
  received→processing→reply_committed→cursor_advanced lifecycle keyed by
  dedupeKey. Redelivery of an acted-on event is dropped; cursor advances only on
  durable completion; stuck-`processing` entries are re-runnable; a remote
  reply-committed marker (dual-medium) prevents a failover re-send. Deterministic
  `computeReplyIdempotencyKey(dedupeKey, replyIndex)`. Self-initializing schema,
  per-agent-id isolation, WAL+busy_timeout (the PendingRelayStore pattern).
- `src/core/HandoffSentinel.ts` (new) — the planned-handoff state machine
  (prepare→tail_synced→ingress_fenced→new_owner_active→old_owner_standby→
  committed). Yields the lease ONLY on a verified ack (echo of tailSeq + ingress
  position + thread-history hash) AND a passing validation; otherwise aborts and
  stays awake. Anti-oscillation floor + a race guard (`inProgress`).
- `src/core/types.ts` — new `IngressPosition` type and OPTIONAL Channel
  Seamlessness Contract methods on `MessagingAdapter`
  (getIngressPosition/stopConsuming/resumeConsuming/dedupeKey).

## Over-block / under-block
- The contract methods are OPTIONAL, so every existing adapter
  (Telegram/Slack/WhatsApp/iMessage) compiles unchanged — no adapter is forced
  "seamless-ready" before it implements + passes the conformance suite.
- The ledger's `record` is INSERT OR IGNORE — a benign double-record is a no-op;
  a genuinely new event is `firstSeen:true`. No over-block (it never refuses a
  first-seen event).

## Signal vs authority
- The ledger is a pure substrate (records facts); it carries no authority. The
  fencing epoch is STORED (reply_epoch) but the authority to send is the lease
  layer's (the fencing-gated outbox, next increment).
- HandoffSentinel encodes the authority rule structurally: no yield without
  verified ack + validation. The validator is a Tier-1 signal; the yield is the
  authority act, gated on it.

## Interactions
- MessageProcessingLedger is standalone (not yet wired into the inbound path —
  that wiring + the fencing-gated outbox is the next G3 increment). No live
  behavior changes from this commit.
- HandoffSentinel is standalone (constructed + wired in the integration step);
  its ops are injected, so it has no ambient dependencies.
- `applyRemoteReplyMarker` uses COALESCE so a local commit already present is
  never downgraded — safe under concurrent local+remote marking.

## Rollback cost
- Minimal — both new modules are unreferenced by live code in this commit; the
  types change is purely additive (optional fields). Reverting removes the files
  with no behavioral impact.

## Tests
- `tests/unit/MessageProcessingLedger.test.ts` (real SQLite, 10 tests): redelivery
  dropped, cursor-only-on-completion, idempotent commit, stuck re-run, dual-medium
  marker. `tests/unit/HandoffSentinel.test.ts` (10 tests): every abort gate proven
  to NOT yield. 77 unit tests green overall.
