# Side-Effects Review — Cross-Machine Seamlessness: outgoing handoff sentinel wiring

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3e (converged, approved)

The OUTGOING-machine orchestration logic for a planned handoff, as a tested unit: drive the
live tail → POST begin → await + verify the ack → validate → yield → demote. Counterpart to
the incoming receiver wiring (commit 79e9bf23f). This increment lands the LOGIC + its
transport primitive; bolting the sentinel into server.ts boot + the operator/test trigger
route + the two-server e2e are the next sub-increment (C2b/C3, tracked in the wiring plan).

## What changed
- `src/core/HandoffWireTransport.ts` — NEW `sendBegin(manifest)` → POST /api/handoff/begin to
  the peer. Symmetric with the existing sendAck/sendYield; rides the same signed channel.
- `src/core/handoffSentinelWiring.ts` — NEW `createHandoffSentinelWiring(deps)` composes a real
  HandoffSentinel with ops bound to injected deps: flush (pushTick the live tail, build the
  manifest with `hashTopicHistory` reused from the receiver wiring so the echo verifies, POST
  begin), awaitAck, validate (default deterministic — ackMatches is the substantive gate; Haiku
  Tier-1 is the spec's tracked upgrade), sendYield, demoteSelf. Returns `{ sentinel, initiate }`.

## Over-block / under-block
- The lease is NEVER yielded unless the ack echo verifies (HandoffSentinel.ackMatches) AND
  validate passes — proven by tests: a mismatched echo, an absent ack, a failed validation, and
  an unreachable-peer begin all return `aborted-stay-awake`/`failed` with ZERO sendYield and
  ZERO demoteSelf calls. The outgoing simply stays awake. No two-holders window.
- flush throws if the begin POST is not accepted (no reachable peer / rejected) → the sentinel
  reports `failed` before any ack wait — it never proceeds to yield on a peer it can't reach.

## Signal vs authority
- The wiring supplies ops only. The DECISION to yield lives in HandoffSentinel (verify + validate
  gate); the lease CAS authority is the incoming coordinator's, triggered solely by the yield.

## Interactions
- Reuses hashTopicHistory (handoffReceiverWiring) so outgoing-flush and incoming-echo hash the
  SAME bytes → the caught-up check is meaningful. Consumes HandoffWireTransport (sendBegin/
  awaitAck/sendYield) + telegram ingress/history + coordinator.demoteToStandby (all shipped).
- NOT yet constructed in server.ts boot; no trigger route yet → no runtime behavior change.
  Bolting in + the trigger + the e2e are C2b/C3. <!-- tracked: topic-13481 -->

## Rollback cost
- Minimal. Two new standalone additions (one method + one module). No boot wiring yet, so a
  revert is a pure no-op on the running pipeline.

## Tests
- `tests/unit/handoff-sentinel-wiring.test.ts` (5): verified+validated ack → flush+yield+demote+
  handed-off ; mismatched echo → abort, no yield ; no ack → abort, no yield ; failed validate →
  abort, no yield ; unreachable-peer begin → failed, no yield. tsc clean; HandoffWireTransport
  unit suite still green (7).
