# Side-Effects Review — Camera acceptance journal adapter

## Summary of the change

Connects the verified Camera journal reader and state fold to the existing request, submission and withdrawal services. The adapter signs a single proposed event and hands it to the supplied lease-fenced durable emission primitive. No production server constructs it yet.

## Decision-point inventory

- Hold when the scoped journal snapshot cannot be verified or folded.
- Check the intended event against the same fold before writing.
- Permit one attempted append per transaction.

## 1. Over-block

A journal whose authoritative head is missing or inconsistent holds valid requests until it recovers. A caller gets one write per lock acquisition.

## 2. Under-block

The supplied backend must enforce the coordinator lease, exact head and lock, and confirm fsync. The server must authenticate and revalidate the assigned verifier. This checkpoint does not supply those dependencies.

## 3. Level-of-abstraction fit

The adapter supplies the shared Camera transaction. The runtime owns authority discovery and persistence, and the Camera services own independent-verifier policy.

## 4. Signal vs authority compliance

The adapter checks deterministic journal invariants. It does not judge owner evidence or send a notice. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals point.

## 5. Interactions

The supplied backend lock spans snapshot and emission. The same read-side fold validates replay of the event. No runtime route or publisher calls this adapter yet.

## 6. External surfaces

No change to public routes, owner actions or outbound notices.

## 7. Multi-machine posture

Intended production backend is the replicated Chief of Staff store under the coordinator lease. No local acceptance store, generated URL or user notice is introduced.

## 8. Rollback cost

Revert the checkpoint. It has no live caller and creates no production state.

## Conclusion

The prototype adapter connects the existing pieces in focused tests. The production snapshot authority and authenticated HTTP caller remain open.

## Second-pass review

The independent reviewer confirmed that each append checks the active binding and that a withdrawal decision matches its reason. A transaction refuses writes from escaped callbacks and waits for any started write before releasing the lock. The reviewer concurred with the unwired checkpoint.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
