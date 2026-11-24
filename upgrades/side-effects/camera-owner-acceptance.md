# Side-Effects Review — Camera owner acceptance prototype

## Summary of the change

The Camera module compares authoritative grant snapshots supplied by a caller and folds an already verified, complete receipt stream for a specific candidate. The prototype has no server caller or persistent storage.

## Decision-point inventory

- Add exact grant comparison for the Camera success, cancellation, expiry and replay trials.
- Add binding and sequence checks for a supplied receipt stream.

## 1. Over-block

The pilot rejects fixtures without a second computer and evidence collected under a different candidate. Those fixtures cannot verify preservation across computers or acceptance of the exact candidate.

## 2. Under-block

The functions cannot establish how a caller collected the snapshots or verified receipts. Connecting them directly to caller-provided data would let fabricated evidence pass. The pilot's production entry point must verify evidence origin, server request identity and complete trusted journal coverage through its authoritative head before calling them. The fold detects internal gaps and cannot detect a withheld tail. The caller must bind the observed time to the authoritative evidence.

## 3. Level-of-abstraction fit

Evidence comparison belongs in the pure Camera function. Session authorization, durable writes and delivery decisions belong to their respective production layers.

## 4. Signal vs authority compliance

The prototype emits evidence and receipt decisions with no authority over a live action. Comparisons are exact, enumerable invariants. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The independent verifier still observes the phone and its real outcome.

## 5. Interactions

There is no runtime consumer, registration, concurrent mutation, notification or retry. The functions do not shadow existing checks or trigger a feedback loop.

## 6. External surfaces

No route, operator action, agent message, persistent schema or external call changes. Unit tests use synthetic grants.

## 7. Multi-machine posture

Every machine computes the same decision from the same complete inputs. The module stores nothing, sends no notice, generates no URL and changes no status surface. The pilot spec assigns persistent state to the Chief of Staff journal.

## 8. Rollback cost

Revert the prototype commit. There are no stored records to migrate, users to notify or state to repair.

## Conclusion

The tested prototype is suitable as a draft checkpoint. Authenticating submissions, persisting receipts and connecting the production pilot remain implementation work.

## Second-pass review

The independent acceptance security reviewer concurred with checkpoint scope and rollback. The review identified the need for authoritative journal coverage through its head and an active expected grant at observation time. The artifact now documents the journal contract and the prototype rejects evidence for a grant expired at observation.

## Evidence pointers

- `tests/unit/camera-owner-acceptance.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
