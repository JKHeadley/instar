# Side-Effects Review — Camera verifier journal authorization

## Summary of the change

Requires a verifier authorization when constructing the Camera journal adapter. The adapter checks it after reading the current state under the lock and rechecks it immediately before handing a signed record to the synchronous emission boundary.

## Decision-point inventory

- Hold a journal transaction when the live verifier does not match its active assignment.
- Refuse emission if the verifier loses authority after the transaction begins.

## 1. Over-block

A revoked verifier or an unavailable assignment holds the request. A replacement verifier needs authorization for the declared assignment.

## 2. Under-block

The runtime must obtain authorization from the strict Camera verifier helper and provide the authoritative assignment source. This checkpoint changes the adapter contract but does not install a route.

## 3. Level-of-abstraction fit

The authorization helper checks credentials and the journal adapter enforces that check under the write lock. Camera evidence judgment stays with the independent verifier.

## 4. Signal vs authority compliance

The decision is an exact identity and epoch invariant. It adds no heuristic or new owner delivery authority. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No competing-signals heuristic is added.

## 5. Interactions

The pre-append recheck happens after signing and validation with no asynchronous gap before the backend's emission call. The current backend performs synchronous checks before invoking the emitter. The restart test supplies a test-only authorization.

## 6. External surfaces

No HTTP route or owner action is added. Production still needs to construct this adapter with real authentication and storage authority.

## 7. Multi-machine posture

Live origin is checked on the serving machine. Assignment comes from replicated Chief of Staff state. This checkpoint creates no additional durable state, links or notices.

## 8. Rollback cost

Revert the constructor and test changes. No live state needs repair.

## Conclusion

The adapter now enforces the authorization contract under the lock. The authenticated HTTP surface and production composition remain separate work.

## Second-pass review

The independent acceptance security reviewer concurred. A replacement backend must preserve the synchronous path from the final authorization recheck to emission.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
