# Side-Effects Review — Camera verifier receipt submission

## Summary of the change

Adds Camera receipt submission against a caller-supplied verified journal transaction. The service checks the server-issued request and active receipt sequence, computes the evidence result and asks the journal to consume the request and append the decision atomically.

## Decision-point inventory

- Require the assigned verifier and a server-issued request for the current candidate, revision and receipt sequence.
- Refuse stale requests and hold when authoritative history is unavailable.
- Compute the result and return it after the atomic durable append.

## 1. Over-block

A receipt recorded after issuance invalidates older outstanding requests, including parallel requests for the same candidate. The verifier can get a fresh request while the pilot has a current non-Pass decision.

## 2. Under-block

The service relies on the production caller to verify live origin, assignment epoch and same-request evidence provenance. The journal adapter must verify head coverage and atomically consume the request. These are trust contracts at this checkpoint.

## 3. Level-of-abstraction fit

Receipt policy comes from the Camera service. The journal owns authoritative sequencing and storage. The route owns origin and evidence authentication.

## 4. Signal vs authority compliance

These are exact binding and sequence checks. The independent verifier supplies observed evidence. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

Issuance and receipt submission use the same milestone lock contract. Each successful append advances the receipt sequence, invalidating requests issued against the previous sequence. There are no production hooks or side effects yet.

## 6. External surfaces

No route, operator action, agent message or persistent schema changes.

## 7. Multi-machine posture

The checkpoint holds no state. Production writes belong to the replicated Chief of Staff journal under the active lease. The checkpoint sends no notices and generates no links.

## 8. Rollback cost

Revert the checkpoint. There is no live rollout or state to repair.

## Conclusion

Request binding and evidence result submission are ready for the draft. The real journal adapter and authenticated route still require implementation.

## Second-pass review

The independent reviewer concurred with the prototype checkpoint. Production requires a separate authenticated, reason-bearing Pending or Fail transition so an active Pass can be retired under the same lock. The production journal must also retain canonical submission identity so that an exact retry after a lost acknowledgment returns the stored receipt and altered reuse conflicts. The prototype currently rejects consumed requests as stale.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
