# Side-Effects Review — Camera replicated journal backend

## Summary of the change

Adds a bridge from Camera transactions to the existing Chief of Staff emitter and journal durability acknowledgment. The server does not construct the bridge in this checkpoint.

## Decision-point inventory

- Hold without reader compatibility, current lease or a verified snapshot from the local holder.
- Recheck compatibility, head and lease immediately before emission.
- Acknowledge only an accepted write with a durable stream sequence.

## 1. Over-block

A legitimate verifier request waits while any participating reader lacks support or the lease or head changes.

## 2. Under-block

The runtime must supply the real conversation lock, compatibility decision and verified head source. This checkpoint accepts those dependencies but installs no runtime caller.

## 3. Level-of-abstraction fit

The backend wraps the existing Chief of Staff emitter and journal. It shares the conversation lock with the server and leaves receipt semantics to the Camera service.

## 4. Signal vs authority compliance

The lease and durability checks enforce enumerable invariants. The backend neither judges phone evidence nor authorizes a notice. See [Signal vs. Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new heuristic at a competing-signals point.

## 5. Interactions

The conversation lock spans the snapshot, emission and durability acknowledgment. An append timeout cannot be interpreted as success. A single bridge instance per process holds another write until the accepted queue entry is confirmed durable. After process restart the verified snapshot provider must reconstruct the durable head and refuse incomplete or unreconciled state. The receipt’s canonical identity handles a retry after an ambiguous result when production wiring supplies the journal inputs.

## 6. External surfaces

No live route, owner action, message or persistence change in this checkpoint.

## 7. Multi-machine posture

The existing Chief of Staff stream is the replication path. The runtime must bind the pilot to the registering holder and suspend writes on handoff. The checkpoint adds no local journal, URL or notice.

## 8. Rollback cost

Revert the checkpoint. No running caller or live record needs repair.

## Conclusion

The focused tests cover compatibility, lease and head checks and the durability acknowledgment. Production authority sources and the authenticated server route remain required.

## Second-pass review

The independent acceptance security reviewer identified sequence reuse after an accepted append times out. The bridge now fences later transactions on the same conversation until that exact stream sequence is confirmed durable. The reviewer confirmed the fix and concurred. The runtime must keep one bridge per server. Its snapshot must include the confirmed event or hold, even while a projection lags, and must reconcile durable authority after restart.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
