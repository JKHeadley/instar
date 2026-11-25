# Side-Effects Review — Camera durable journal snapshot

## Summary of the change

Derives the Camera terminal identity from the local holder's complete durable Chief of Staff stream. The source verifies the scoped local and union views against that identity, compares every verified signed body, and rechecks coverage before an append.

## Decision-point inventory

- Hold for queued or incomplete local data, missing union coverage, or stream changes during read.
- Require both local and union Camera records to match the independently derived terminal identity.

## 1. Over-block

A partial stream, a lagging union, or unrelated queued Chief of Staff writes may hold the pilot. This is conservative for one Camera milestone.

## 2. Under-block

The existing durable stream high-water and complete reader are the local storage authority. A coordinated loss of stream and high-water evidence is outside this checkpoint. The server must supply the real matching lease, holder verification key and complete union function.

## 3. Level-of-abstraction fit

The snapshot source reads storage and independently attests the local terminal record. Signature and receipt semantics stay in the reader and fold.

## 4. Signal vs authority compliance

Head coverage and signature checks are enumerable invariants. No owner decision or notice authority is added. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

The source flushes queued journal work, reads the bounded local stream and verifies the complete union. The shared conversation lock and current lease are supplied by the backend. This explicitly relies on complete retention for the first pilot epoch. Reads cap at the journal's existing limits.

## 6. External surfaces

No production caller, public route, user action or persistent format changes.

## 7. Multi-machine posture

The existing Chief of Staff journal is the replicated path. Local durable records attest the registering holder's head, while peer coverage contributes to the union. The pilot suspends on lease handoff.

## 8. Rollback cost

Revert the checkpoint. It has no live caller or records to migrate.

## Conclusion

Focused tests cover head derivation, changed head, incomplete union and unresolved append. Server composition and authenticated routes remain necessary for the pilot.

## Second-pass review

The independent reviewer found that an earlier union record could differ even if the terminal identity matched. The source now compares every verified record body, and a focused test covers a different earlier record under the same terminal identity. The reviewer confirmed the fix and concurred.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
