# Side-Effects Review — Camera acceptance journal reader

## Summary of the change

Adds a pure reader for a scoped Camera event stream. It checks envelope provenance, keys, signatures, sequence continuity and the independently supplied head before returning ordered records.

## Decision-point inventory

- Hold when the authority is unavailable or journal coverage differs from its head.
- Hold when a matching record has invalid provenance, signature, sequence or content.
- Accept identical transport duplicates without losing same-sequence conflicts.

## 1. Over-block

A missing record or invalid signature holds an otherwise usable pilot. The supplier must restore the complete verified stream before using a receipt.

## 2. Under-block

A falsely supplied head could hide a missing tail. Production must independently establish the exact scope, historical holder and complete authoritative head for the same snapshot, including the terminal signed identity. This checkpoint accepts those through a caller-supplied contract.

## 3. Level-of-abstraction fit

The reader enforces deterministic stream consistency. Authority discovery belongs to the production journal adapter. Receipt semantics belong to the state fold.

## 4. Signal vs authority compliance

The reader yields verified records or an unavailable signal. It neither judges the phone journey nor authorizes action. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

The reader shares the signature canonicalization and key codec with the store. No existing runtime caller changes behavior.

## 6. External surfaces

No route, operator action, message or persistent format changes.

## 7. Multi-machine posture

Production inputs come from the replicated Chief of Staff journal and its lease authority. The reader holds no local state and sends no notices or links.

## 8. Rollback cost

Revert the checkpoint. There are no new stored records or live callers to repair.

## Conclusion

The reader is ready as a prototype checkpoint. Production authority discovery and event-state folding remain required.

## Second-pass review

The independent acceptance security reviewer identified an escaping verifier exception. The reader now holds on provider errors, and a regression test covers that case. The reviewer confirmed the fix and concurred.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
