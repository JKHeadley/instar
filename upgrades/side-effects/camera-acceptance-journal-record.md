# Side-Effects Review — Camera acceptance journal records

## Summary of the change

Adds a structured Camera record to the Chief of Staff replication schema. The record defines the signed bytes and immutable key for requirements, issued requests, evidence receipts and withdrawals. No production publisher emits it in this checkpoint.

## Decision-point inventory

- Require bounded, exact fields at the replication parser.
- Bind the signing bytes and immutable key to the conversation, binding, epochs and event.
- Refuse construction of a record whose claimed holder differs from the emitter.

## 1. Over-block

The schema rejects unknown event versions and unexpected nested fields. Emitters must remain dark until the participating readers support this record version.

## 2. Under-block

Structural validation alone cannot establish signature or lease authority. A consuming fold must verify the historical holder, reconfirm the envelope key and origin, validate coverage and inspect sequence conflicts before returning a decision.

## 3. Level-of-abstraction fit

The codec validates shape and canonical identity. The publisher owns lease fencing, and the consuming fold owns historical authorization and sequencing.

## 4. Signal vs authority compliance

Shape and signing inputs are deterministic invariants. The codec does not decide a verdict or authorize delivery. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

The key includes the signed record, retaining conflicting events for later verification. The schema reserves the prefix and rejects deletes, mismatched types, wrong origins and content that does not match the key. Existing folds continue to read their own record types. This checkpoint adds no emitter, retry or notice path.

## 6. External surfaces

The replication schema can carry the new variant. No route or runtime producer is added. Older process versions must not encounter these records before the configured reader rollout is complete.

## 7. Multi-machine posture

Records use the existing replicated Chief of Staff journal. No local store, generated link or owner notice is introduced.

## 8. Rollback cost

Revert the schema checkpoint while emission is dark. If a later release has emitted records, retain reader support while disabling its publisher.

## Conclusion

The schema and signing input are ready as a draft checkpoint. Version-gated emission and authenticated folding remain implementation requirements.

## Second-pass review

The independent acceptance security reviewer identified two issues. The signer now excludes the signature and validates the unsigned body, and the store reserves Camera keys before generic tombstone handling. The reviewer confirmed both fixes and concurred with the checkpoint.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
