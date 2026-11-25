# Side-Effects Review — Camera protected evidence storage reader

## Summary of the change

Reads one bounded artifact by issued Camera request ID from an owner-only directory under the agent state directory. The reader adds no writer or runtime registration.

## Decision-point inventory

- Refuse invalid request IDs, unsafe directory and file permissions, links and nonregular files.
- Return no evidence for missing, changed, malformed or oversized records.

## 1. Over-block

An otherwise valid record is held if it exceeds the byte limit, is not owner-only, or is on a platform without the required open flags.

## 2. Under-block

A same-OS-principal actor is outside this storage boundary. The production evidence source must verify the attester signature, exact request and freshness independently. Production must publish immutable artifacts atomically and provide owner-controlled state-directory ancestry that other accounts cannot replace.

## 3. Level-of-abstraction fit

This layer reads bounded storage. It does not interpret Camera evidence or authorize a receipt.

## 4. Signal vs authority compliance

File and request checks are exact invariants. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

The reader never creates a directory or file. An unavailable artifact holds the caller. A symlink at the artifact is refused before bytes are read.

## 6. External surfaces

No production caller, route, message or owner action changes.

## 7. Multi-machine posture

Camera captures remain on their authorized artifact owner. Serve protected evidence through the owning holder; other machines use the replicated receipt and metadata. This checkpoint adds no new URL or notice.

## 8. Rollback cost

Revert the checkpoint. It creates no state to delete or repair.

## Conclusion

The reader is ready for the draft. Production still needs atomic artifact publication, freshness attestation and boot composition.

## Second-pass review

The independent reviewer concurred for trusted state-directory ancestry. The reader additionally refuses a state root writable by other accounts and checks the evidence directory identity after opening the file.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
