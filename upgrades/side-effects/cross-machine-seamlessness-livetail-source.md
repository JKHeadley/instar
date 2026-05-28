# Side-Effects Review — Cross-Machine Seamlessness: LiveTailSource (holder flush producer)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3b (converged, approved)

Fourth piece of the wire-transport increment. The holder-side producer that drives
the live-tail SENDER (HttpLiveTailTransport.broadcast) — the missing primitive that
makes the encrypted stream actually fire, and that the handoff flush() builds its
manifest from.

## What changed
- `src/core/LiveTailSource.ts` — NEW, standalone. Per-topic delta accounting: tracks
  the content already streamed to the standby and emits only the NEW suffix as a
  monotonic-sequence flush (the standby's LiveTailBuffer APPENDS contiguous flushes,
  so the source must send deltas, not the full tail). Drivers: pushTick() (cadence,
  keeps the standby fresh to liveTailMaxStalenessMs) and flushTopic/flushAll (handoff,
  returns per-topic seqs for the manifest). currentSeq() exposes the high-water for
  the manifest. Content provider + transport injected → channel-agnostic + testable.

## Over-block / under-block
- A failed broadcast does NOT advance the streamed/seq state, so the same delta retries
  on the next tick (the buffer dedups on seq, so a retry is harmless). This is the
  correct under-action: never mark content delivered that the standby didn't ack.
- No new content → no flush, no seq bump — duplicate ticks can't inflate the standby's
  sequence or push empty flushes.
- Content divergence (history rewrite/compaction shrinks or changes the prefix) → resend
  the full content as a fresh delta, rather than send a broken suffix.

## Signal vs authority
- Pure producer — no authority. It decides only WHAT content is new; it does not decide
  who leads or who may send (the lease/FencedOutbox do). It is gated upstream: the wiring
  step only runs the cadence/handoff flush on the machine that holds the lease.

## Interactions
- Drives HttpLiveTailTransport.broadcast (already shipped, redacts+encrypts). The
  correctness test feeds the source's deltas through a REAL LiveTailBuffer and asserts
  the original conversation is reconstructed exactly — the delta model and the buffer's
  append model are proven consistent.
- **Next piece (same increment):** the integrating commit wires LiveTailSource into the
  server (content provider = recent topic messages; cadence timer on the holder; handoff
  flush() = flushAll() + manifest from currentSeq), takes the handoff routes live, binds
  HandoffSentinel ops, and adds the boots-the-server e2e test.

## Rollback cost
- Minimal — one new standalone file, unreferenced by the live path until the wiring step.

## Tests
- `tests/unit/LiveTailSource.test.ts` (6): first-flush-full / subsequent-delta, no-new-
  content no-op, divergence resends full, failed-broadcast-does-not-advance (retry-safe),
  **deltas reconstruct the original tail through a real LiveTailBuffer**, flushAll covers
  all topics. tsc clean.
