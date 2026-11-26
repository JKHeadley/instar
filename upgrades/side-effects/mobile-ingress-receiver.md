# Shared mobile ingress receiver checkpoint

## Summary of the change

The mobile receiver stages verified payloads and authorizes holder claims under independently enrolled roles.

## Decision-point inventory

Stage requires authenticated ingress and an exact signed envelope from that machine. Claim requires authenticated enrolled holder, saved event evidence, current device policy and the transactional generation check.

## 1. Over-block

Unavailable authentication, payload size or table capacity prevents a waiting acknowledgement. Before activation, prune settled payloads while preserving the exact claim tombstone and all uncertain custody.

## 2. Under-block

The store changes no live authority. A live receiver must derive membership from trusted enrollment and recheck revocation and dispatch authority.

## 3. Level-of-abstraction fit

The storage transaction arbitrates generation and claim. The receiver handles policy and proof validation.

## 4. Signal vs authority compliance

Staging does not confer dispatch authority. An existing claim grants no second attempt. No callback dispatches an operation in this checkpoint.

## 4b. Judgment-point check

The receiver uses exact policy predicates and persisted identity. It does not infer an actor from message content.

## 5. Interactions

Pending handover still admits valid staged records but blocks both generations from claiming. The verified digest binds the body, stored text, sender identity and role, and exact attachment references. Downstream dispatch must consume the stored payload associated with the committed claim.

## 6. External surfaces

No runtime endpoint or app route uses this composition.

## 7. Multi-machine posture

Roles are independent. The single storage instance still needs a durable external rollback floor and authenticated transfer.

## 8. Rollback cost

The additive SQLite table is unused by production. Removing the module leaves existing claim records intact.

## Second-pass review

Concur for the dark checkpoint. The digest includes dispatch-relevant sender identity and stored attachment references. A role-changed retry conflicts. No dispatch or transport was added.
