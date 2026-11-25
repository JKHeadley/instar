# Side-Effects Review — Camera verifier authentication

## Summary of the change

Resolves an independently assigned Camera verifier through the strict origin credential path and provides a synchronous check for use under the Camera journal lock. No production route invokes it in this checkpoint.

## Decision-point inventory

- Require a verified local session credential and matching incarnation.
- Require the current stable verifier and assignment epoch.
- Recheck the credential and trusted assignment before any write.

## 1. Over-block

A valid verifier whose registry, observer or assignment cannot be read cannot record a receipt until authority is restored.

## 2. Under-block

The runtime must use the actual session registry, producer verifier and authoritative assignment source. The route must call the synchronous recheck while holding the adapter lock and prevent a failed recheck from emitting. This helper is not a standalone authentication endpoint.

## 3. Level-of-abstraction fit

Reuses the existing live-session credential machinery. The Camera-specific layer matches the resolved identity to the active requirement.

## 4. Signal vs authority compliance

Exact session and assignment binding are deterministic invariants. An independent verifier still judges the evidence. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is introduced.

## 5. Interactions

No fallback via launch records or generic bearer authorization. No existing route behavior changes. The caller owns the write lock.

## 6. External surfaces

No new route, owner action, message or persistent format changes.

## 7. Multi-machine posture

The credential and live-session check apply to the serving machine. Requirements and assignments belong to the replicated Chief of Staff state. No new local durable data, notice or URL is introduced.

## 8. Rollback cost

Revert the checkpoint. No production records or clients need repair.

## Conclusion

The strict authentication helper is ready for route composition. It is inactive until wired to the journal adapter and authoritative assignment source.

## Second-pass review

The independent acceptance security reviewer concurred with the unwired checkpoint. The production route must use the synchronous check at its last point before emission after awaited evidence and lock acquisition.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
