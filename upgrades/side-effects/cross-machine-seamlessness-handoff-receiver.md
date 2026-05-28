# Side-Effects Review — Cross-Machine Seamlessness: HandoffReceiver (incoming side)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3d/G3e (converged, approved)

The INCOMING-machine half of the planned handoff — the counterpart to the
outgoing-only HandoffSentinel. Completes the two-sided handoff protocol at the
component level (both sides now exist + tested; only server wiring remains).

## What changed
- `src/core/HandoffReceiver.ts` — NEW, standalone state machine:
  idle → catching_up → ack_sent → acquired | failed.
  - onBeginHandoff(): builds the caught-up ack (tailSeq + ingressPosition +
    threadHistoryHash), sends it to the outgoing machine. Build/send failure → failed.
  - onYield(): acquires the lease via the consented path — but ONLY while a handoff
    is genuinely in progress (state ack_sent). A stray yield is ignored.
  All I/O (buildAck/sendAck/acquireOnYield) injected → unit-testable, channel-agnostic.

## Over-block / under-block
- Acting on yield ONLY in ack_sent is a deliberate over-guard: a stray/replayed yield
  with no handoff underway is ignored (and the lease's own consent guard already refuses
  a yield from a non-holder — defense in depth).
- A failed consent acquire leaves the machine STANDBY (failed state), never a partial/
  ambiguous role — pairs with the outgoing's "stay awake on no verified handoff", so a
  broken handoff degrades to "no change", never to two-leaders or no-leader.

## Signal vs authority
- No authority of its own — it sequences signals (ack out, yield in) and delegates the
  authority mutation to coordinator.acquireLeaseOnConsent (which is itself guarded). The
  DECISION to yield lives on the outgoing (HandoffSentinel).

## Interactions
- Pairs with HandoffSentinel (outgoing), HandoffWireTransport (sendAck/onYield delivery),
  LiveTailBuffer (tailSeq for the ack), and coordinator.acquireLeaseOnConsent (the acquire).
- **Next (final integration):** server.ts constructs both HandoffSentinel + HandoffReceiver,
  binds their ops to the live transports/coordinator/telegram, wires the routes live
  (onHandoffAck→sentinel.recordAck via HandoffWireTransport; onHandoffYield→receiver.onYield;
  a begin-handoff signal→receiver.onBeginHandoff), adds the handoff trigger + the live-tail
  streaming cadence + the content provider, and ships the boots-the-server e2e test.

## Rollback cost
- Minimal — one new standalone file, unreferenced by the live path until the integration step.

## Tests
- `tests/unit/HandoffReceiver.test.ts` (6): begin→build+send ack; ack-not-accepted → failed;
  buildAck-throws → failed; yield-after-ack → acquired; stray-yield-ignored; failed-acquire
  → standby. tsc clean.
