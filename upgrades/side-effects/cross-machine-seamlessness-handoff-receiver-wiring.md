# Side-Effects Review — Cross-Machine Seamlessness: incoming handoff receiver wiring

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3d/G3e (converged, approved)

Wires the INCOMING side of the planned handoff into the live server: the begin route
now drives a real HandoffReceiver that builds + sends the caught-up ack, and the yield
route now drives the lease CAS. Closes the gap where HandoffReceiver was a tested class
with no production caller (spec §10 mandates it be constructed in startup, not dead code).

## What changed
- `src/core/handoffReceiverWiring.ts` — NEW. `createHandoffReceiverWiring(deps)` composes a
  HandoffReceiver with ops bound to injected deps (sendAck, acquireLeaseOnConsent,
  getTopicHistory) and returns `{ receiver, onBegin, yieldHandler }`. Extracted as a unit
  (not inline in server.ts) per the Testing Integrity Standard so the DI wiring is testable.
  Also exports `hashTopicHistory(getTopicHistory, topic)` — the canonical thread-history hash
  the OUTGOING flush must reuse so the echo verifies. The hash uses the SAME content
  formatting as LiveTailSource (`[ts] text\n`).
- `src/commands/server.ts` — in the mesh/git block, when a handoffWireTransport + telegram +
  coordinator exist, build the wiring, register `transport.onYield(wiring.yieldHandler)`, and
  pass `wiring.onBegin` as the AgentServer `onHandoffBegin`. Gated on coordinator.enabled; a
  solo/non-mesh agent constructs nothing.

## Over-block / under-block
- The lease CAS (`acquireLeaseOnConsent`) is invoked ONLY by the yield handler, and the
  HandoffReceiver ignores a yield unless it is in `ack_sent` (a handoff is genuinely underway).
  A bare/forged yield with no prior begin → no CAS (tested). The ack never moves the lease.
- buildAck RECOMPUTES the hash from this machine's own synced history — it never echoes the
  manifest's own hash. A not-caught-up standby therefore produces a non-matching echo, and the
  outgoing's verify (HandoffSentinel.ackMatches) refuses to yield (tested: caught-up matches,
  stale differs).
- Manifest absent at buildAck time → throws → receiver goes `failed`, no ack sent (safe).

## Signal vs authority
- The wiring carries signals (manifest in, ack out) and triggers the consent-gated CAS, which
  is the coordinator's authority. The wiring itself mutates no role/registry state.

## Interactions
- Reuses telegram.getTopicHistory (same call LiveTailSource uses for the tail content),
  coordinator.acquireLeaseOnConsent (already shipped), and the HandoffWireTransport (sendAck /
  onYield). The OUTGOING HandoffSentinel (next increment C2) POSTs the begin + drives the
  flush and must reuse `hashTopicHistory` for the echo to verify. <!-- tracked: topic-13481 -->

## Rollback cost
- Low. One new standalone module + a gated wiring block. Reverting leaves the begin/ack/yield
  routes 503 (no callback supplied) — exactly the prior state, no behavior change to a solo agent.

## Tests
- `tests/unit/handoff-receiver-wiring.test.ts` (3): begin → caught-up ack echoes tailSeq +
  ingressPosition + a hash matching the outgoing's (caught-up) ; a stale local history yields a
  NON-matching hash (so the echo won't verify) ; a yield with no handoff is ignored, and a yield
  after a begin drives acquireLeaseOnConsent with the begin originator's machine id, reaching
  `acquired`. tsc clean.
