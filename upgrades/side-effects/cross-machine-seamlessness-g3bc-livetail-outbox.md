# Side-Effects Review — Cross-Machine Seamlessness: live-tail buffer + redaction + fenced outbox

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3a/G3b/G3c (converged, approved)

## What changed (all new, standalone modules)
- `src/core/LiveTailBuffer.ts` — standby-side persisted tail with strict
  sequence-dedup: applies a flush only at lastAppliedSeq+1, holds out-of-order,
  drops duplicates, and after liveTailOutOfOrderTimeoutMs declares an unfillable
  gap (discards held, proceeds) — bounding the holdout and preventing context
  corruption. Per-topic byte cap (drop-oldest).
- `src/core/liveTailRedaction.ts` — versioned (REDACTION_CATEGORY_VERSION) named
  enum of credential categories + redactForLiveTail(); scrubs bearer tokens,
  private-key blocks, AWS keys, JWT-like, api-keys, secret assignments before any
  tail content leaves the machine.
- `src/messaging/FencedOutbox.ts` — structural no-duplicate-reply at the send
  path: sends only while holding the lease at the stamped epoch; suppresses a
  fenced (no-lease / stale-epoch) machine's reply; idempotent via the ledger's
  acted-on check + deterministic idempotency key.

## Over-block / under-block
- FencedOutbox SUPPRESSES on no-lease/stale-epoch — intended over-block (a fenced
  machine must not send). Risk of under-send if `holdsLease()` is wrongly false;
  mitigated because a single machine trivially holds its lease, and the stamped
  epoch equals the current epoch in the normal (non-handoff) case.
- Redaction is conservative/high-precision; over-redaction (a false positive) is
  acceptable per spec ("false positives cheaper than a leak"). Ordinary prose is
  left untouched (tested).

## Signal vs authority
- FencedOutbox consults the lease authority (holdsLease/currentEpoch injected) —
  it does not itself decide authority, it enforces it at the send boundary.
- LiveTailBuffer is a pure data structure (no authority); it only guarantees
  context integrity on the receiving side.

## Interactions
- All three are standalone in this commit (not yet wired into the live message
  path — that integration is the next increment). No runtime behavior changes.
- FencedOutbox depends on MessageProcessingLedger (already shipped) — commitReply
  is idempotent, so a double-send attempt is safe.
- Redaction is designed to run before the (encrypted) transport; carry-by-
  reference for large tool output (a follow-on in the transport wiring) reduces
  the raw sensitive surface structurally beyond pattern-matching.

## Rollback cost
- Minimal — unreferenced by live code. Reverting removes the files.

## Tests
- `tests/unit/LiveTailBuffer.test.ts` (9): order, dup-drop, hold+drain,
  gap-discard, byte cap, redaction categories. `tests/unit/FencedOutbox.test.ts`
  (5): send, already-replied, fenced-no-lease, fenced-stale-epoch, send-failed.
  91 unit tests green overall.
