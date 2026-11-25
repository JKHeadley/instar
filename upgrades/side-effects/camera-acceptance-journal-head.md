# Side-Effects Review — Camera authoritative journal head

## Summary of the change

The Camera journal reader now requires the authority to supply both the terminal sequence and immutable key. A complete-length slice ending in a different valid signed record holds acceptance.

## Decision-point inventory

- Check consistency between the attested sequence and terminal key.
- Reject a signed terminal record whose key does not match the authority.

## 1. Over-block

An unavailable terminal identity holds an otherwise usable stream. The production authority must supply the identity from the same complete snapshot.

## 2. Under-block

This change checks the terminal identity supplied by the authority. It cannot establish historical authority or discover withheld nonterminal records absent from the supplied view. The production lease-fenced snapshot must independently establish completeness and scope.

## 3. Level-of-abstraction fit

The reader compares its verified terminal event to the authority. Durable authority discovery belongs to the production backend.

## 4. Signal vs authority compliance

The terminal key comparison is deterministic. No new heuristic or delivery authority is added. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The current reader and adapter tests now supply the required key. When equivalent valid signature encodings arrive in either order, the fold keeps the representation that matches the terminal attestation. No production caller invokes either component.

## 6. External surfaces

No running route, notice, owner action or durable schema changes.

## 7. Multi-machine posture

The production input belongs to the lease-fenced replicated Chief of Staff journal. The checkpoint has no local durable state, notice or URL.

## 8. Rollback cost

Revert the checkpoint. No live state requires repair.

## Conclusion

The camera authority contract binds accepted coverage to the terminal signed identity. Production still needs to provide its verified snapshot.

## Second-pass review

The independent acceptance security reviewer concurred and noted that equivalent signature encodings could otherwise make terminal checks depend on arrival order. The reader now keeps the attested representation. A regression test covers both arrival orders.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
