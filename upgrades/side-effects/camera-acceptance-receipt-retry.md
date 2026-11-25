# Side-Effects Review — Camera evidence receipt retries

## Summary of the change

The Camera receipt service records a canonical evidence digest alongside the receipt and consumed request. It can recover the recorded result of an exact retry through the journal transaction.

## Decision-point inventory

- Check the authenticated verifier and current candidate, then look up the prior submission under the milestone lock.
- Return the recorded receipt for an exact retry and conflict for altered evidence.
- Append the evidence digest with the receipt and consumed request as one operation.

## 1. Over-block

A retry with changed evidence conflicts even when the change would produce the same decision. It needs a new request. A retry for a superseded candidate stays stale.

## 2. Under-block

The production route must validate and bound evidence before hashing. The adapter verifies prior submission records through the authoritative journal head and appends one lease-fenced event. Those production pieces remain unwired.

## 3. Level-of-abstraction fit

Exact retry binding is a service invariant. The existing canonical hash implementation supplies the digest. The journal owns persistence, coverage and atomic consumption.

## 4. Signal vs authority compliance

The exact retry identity is enumerable. No new authority judges evidence meaning. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

Exact retries return the historical receipt without writing or reactivating a Pass. Current decisions still come from the receipt fold. No production caller triggers the service in this checkpoint.

## 6. External surfaces

No production API, external message, owner action or deployed schema changes.

## 7. Multi-machine posture

The prototype holds no state. The production implementation stores the digest and receipt in the replicated Chief of Staff journal. The checkpoint emits no notices and generates no URLs.

## 8. Rollback cost

Revert the checkpoint. No live records require migration.

## Conclusion

The exact retry rule is ready as a draft checkpoint. The verified journal adapter must implement the demonstrated contract before rollout.

## Second-pass review

The independent acceptance security reviewer concurred. The production caller must keep the historical retry response distinct from the current acceptance decision.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
