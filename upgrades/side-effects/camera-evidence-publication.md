# Side-Effects Review — Camera protected evidence publication

## Summary of the change

Adds a bounded owner-only artifact writer. It stages and syncs a complete record, publishes it without replacing an existing request file, cleans up the staging file and syncs the destination directory and its state-directory parent. No production caller invokes it.

## Decision-point inventory

- Reject malformed evidence and unsafe storage.
- Publish one immutable destination per issued request.
- Report unavailable when durable publication is uncertain.

## 1. Over-block

An existing artifact is preserved even when another input claims the same request. A partial or ambiguous write holds the caller.

## 2. Under-block

The writer validates the shape. A trusted caller must establish trial provenance and verify the attester before allowing publication. State-directory ancestry must be owner-controlled and protected against replacement.

## 3. Level-of-abstraction fit

The writer handles private atomic storage. The attester and verifier handle provenance and the journal controls receipt authority.

## 4. Signal vs authority compliance

Storage identity and no-replacement publication are deterministic invariants. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

Concurrent writers cannot replace the destination. The reader holds while a staging link exists. A process crash between link and cleanup may leave a second link and hold the reader. Production requires a safe reconciliation path for this case before enabling the writer. Production must also serialize reader admission with durable publication. The directory entry may become visible after staging cleanup and before the directory sync returns.

## 6. External surfaces

No running writer, route, owner action or notice changes.

## 7. Multi-machine posture

Protected artifacts stay with their authorized owner. The receipt and evidence digest are replicated in the Chief of Staff journal. This checkpoint emits no links or notices.

## 8. Rollback cost

Revert the unwired checkpoint. No deployed writer or existing records need repair.

## Conclusion

The protected writer demonstrates no-replacement publication and bounded private reads. Production still needs independently attested evidence, restart reconciliation and startup composition.

## Second-pass review

The independent reviewer checked no-replacement and crash behavior. The writer now syncs the parent directory. The live composition must hold reader admission until a durable publication acknowledgment and reconcile stale staging links after restart.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
