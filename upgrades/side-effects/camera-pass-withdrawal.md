# Side-Effects Review — Camera Pass withdrawal

## Summary of the change

Adds Pending and Fail transitions for the exact active Camera Pass through a caller-supplied journal transaction. No production caller instantiates this checkpoint.

## Decision-point inventory

- Require the assigned verifier and the exact active candidate, revision and Pass sequence.
- Resolve exact withdrawal retries from the journal and refuse changed reuse.
- Append the reason and replacement receipt as one durable operation.

## 1. Over-block

A verifier who references a superseded Pass must reread the active receipt. This prevents withdrawing a newer Pass by accident.

## 2. Under-block

The service relies on the journal adapter for verified coverage, lease fencing and live assignment revalidation. The production caller must validate the request schema and authenticate the live session. Production wiring is absent from this checkpoint.

## 3. Level-of-abstraction fit

The service implements the Camera transition. The journal owns serialization and storage, and the server owns origin verification.

## 4. Signal vs authority compliance

The active binding and exact retry identity are enumerable. The verifier supplies the reason for withdrawing acceptance. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is added.

## 5. Interactions

The withdrawal uses the same lock contract as request issuance. Its next receipt sequence invalidates earlier requests. Retry lookup precedes the active Pass check so an exact retry can recover its committed result.

## 6. External surfaces

No production route, operator action, notice or persistent schema changes in this checkpoint.

## 7. Multi-machine posture

Production state belongs in the replicated Chief of Staff journal. The module holds no state, sends no notices and generates no URLs.

## 8. Rollback cost

Revert the checkpoint. No live records need repair.

## Conclusion

The tested transition is ready for draft review. The real journal adapter and authenticated route are separate integration work.

## Second-pass review

The independent acceptance security reviewer concurred with the checkpoint. The production adapter must verify and fence both withdrawal lookup and append under the shared lock.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
