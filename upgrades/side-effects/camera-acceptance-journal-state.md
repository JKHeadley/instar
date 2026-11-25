# Side-Effects Review — Camera journal state

## Summary of the change

Reconstructs the current Camera requirement, receipts and request retry indexes from ordered, verified events. No runtime caller instantiates this fold in the checkpoint.

## Decision-point inventory

- Reject an invalid requirement, assignment, request sequence or receipt transition.
- Restore the current revision and the pilot-wide retry identity indexes. A newer revision starts without acceptance.

## 1. Over-block

An inconsistent event holds the pilot. The adapter must restore the verified stream before serving a result.

## 2. Under-block

The fold relies on the journal reader for authority, scope and coverage. Runtime registration must independently verify the Design approval reference.

## 3. Level-of-abstraction fit

The fold reconstructs Camera state. The journal reader owns verification and the adapter owns locking and writes.

## 4. Signal vs authority compliance

Receipt transitions and bindings are exact invariants. The independent verifier supplies the evidence judgment. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

A later receipt advances the issuance sequence. Superseded candidate state stays in the journal and cannot authorize the current revision. The fold retains issued IDs and recorded submission and withdrawal identities across revisions to detect reuse. Historical results cannot change the current decision.

## 6. External surfaces

No caller, API, notice or persistent schema changes.

## 7. Multi-machine posture

Production inputs come from the replicated Chief of Staff journal. The fold holds no persistent local state and emits no messages or links.

## 8. Rollback cost

Revert the checkpoint. No live state needs repair.

## Conclusion

The fold is ready for the draft after focused verification. Production authority discovery, locking and wiring remain open.

## Second-pass review

The independent reviewer checked sequencing, consumption and assignment binding. The review identified an ambiguity about withdrawal IDs across revisions. The fold now retains both request and withdrawal identities for the pilot. The reviewer confirmed the change and concurred.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
