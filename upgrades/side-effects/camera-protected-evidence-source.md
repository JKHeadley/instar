# Side-Effects Review — Camera protected evidence source

## Summary of the change

Adds bounded parsing and attestation checks for protected Camera evidence. It binds the signed record to the issued request, reviewer and exact pilot scope. No runtime caller is installed.

## Decision-point inventory

- Reject unexpected fields and mismatched request, reviewer or scope.
- Verify the attester before returning evidence.

## 1. Over-block

An unavailable or malformed protected artifact holds the result. A legitimate fixture with more than 256 grants per snapshot also holds.

## 2. Under-block

Production must supply bounded immutable storage and an independently authorized attester. The journal checks candidate and request currency. This helper does not prove how the attester collected the evidence.

## 3. Level-of-abstraction fit

The evidence reader validates format and provenance. The Camera journal decides whether a receipt can be recorded.

## 4. Signal vs authority compliance

Provenance and scope checks are exact invariants. The independent verifier supplies judgment and evidence. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No static heuristic at a competing-signals point is introduced.

## 5. Interactions

Read failures return unavailable evidence. This checkpoint adds no route or writer.

## 6. External surfaces

No running API, persistent schema, notice or owner action changes.

## 7. Multi-machine posture

The source reads an injected protected artifact service. The pilot's result belongs to the existing replicated Chief of Staff journal. No local store or generated URL is introduced.

## 8. Rollback cost

Revert the checkpoint. It creates no records to repair.

## Conclusion

The protected evidence checker is ready for draft testing. Production protected storage, attester enrollment and boot composition remain open.

## Second-pass review

The independent acceptance security reviewer concurred with the unwired evidence checker. Production attestation must prove the actual runtime trial used the issued request and that observation occurred after issuance. A signed timestamp and request ID alone do not establish freshness.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
