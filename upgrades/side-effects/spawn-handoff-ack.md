# Side-Effects Review — remote placement reads the spawn ACK

**Version / slug:** `spawn-handoff-ack`
**Date:** `2026-11-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (inbound dispatch is a high-risk surface)`

## Summary of the change

Tier 1 (narrow bug fix, a revert fully undoes it). Files: `src/core/SessionRouter.ts`, `src/commands/server.ts`, `src/core/QueueDrainLoop.ts`, test doubles in five router test files, new tests in `tests/unit/SessionRouter.test.ts`, `tests/unit/session-router-spawn-ack-wiring.test.ts`, `tests/unit/queue-drain-loop.test.ts` and `tests/unit/silent-loss-route-outcome-ratchet.test.ts`. Effort: one build pass plus one fix from the second-pass review, no spec rounds.

Incident (Echo Bugs topic 10000001183, 2026-11-01 22:00:16Z): message 1169 in topic 10000000001 reached the Studio (router). The topic had a released ownership record, so the router placed it on the Mama PC and called `spawnOnMachine`. That hop sent `deliverMessage` with `ownershipEpoch: 0` and discarded the mesh reply (`MeshRpcClient.send` never throws on a non-200). The Mama PC held the older record (epoch > 0), so `createDeliverMessageHandler` NACKed `stale-ownership`. The router still returned `spawned, acked`, the inbound handler skipped local dispatch, and stuck-recovery later skipped the message because "the owner drains it". Studio log: `route topic 10000000001 → action=spawned owner=m_e8c9… acked=true` at 22:00:24.339Z. The next message (22:15:47) went through `forwardToOwner` with the real epoch and worked.

Fix: `spawnOnMachine` now takes the epoch the placement CAS landed, carries the sender envelope, and returns the receiver's ACK (throws on transport failure or a non-ACK reply, exactly like the `deliverMessage` dep). `placeAndClaim` retries it with the forward path's backoff and reads the ACK: `queued`/`duplicate` → confirm + `spawned`; `sender-rejected` → terminal `rejected`; `stale-ownership` or unreachable → new `reclaimPlacement` dep force-claims the still-placing record for this machine and handles locally; if that is unavailable, durable custody; if that refuses, un-acked → today's local fall-through.

## Decision-point inventory

- `QueueDrainLoop` maxAttempts escape — modify — a `'local'` re-place verdict now goes through one real local dispatch instead of being counted delivered.
- `SessionRouter.placeAndClaim` remote branch — modify — the "did the remote spawn take the message" decision now reads the ACK instead of assuming yes.
- `isRemotelyHandled` (server inbound short-circuit) — pass-through — unchanged; it now receives `handled-locally`/`queued` instead of a false `spawned` when the spawn failed.

---

## 1. Over-block

No block/allow surface — the change only stops a false "delivered" verdict. A receiver that accepts is handled exactly as before.

---

## 2. Under-block

- A receiver that ACKs `queued` and then crashes before starting the session: unchanged, covered by its own receipt/inject ledger (`markRemoteInjected` boot detection), not by this change.
- A transport timeout after the receiver actually accepted: the router takes the placement back and handles locally while the receiver also starts a session (one duplicate reply). Bounded to that message; the duplicate-session reconciler owns the convergence. Delivery beats loss.
- stuck-recovery still trusts "owned by a reachable peer". With this fix the router no longer reports a remote owner for a message the owner never took, which removes the case seen here.

---

## 3. Level-of-abstraction fit

Right layer: the router owns the retry/fallback loop for forwards; the spawn hop now uses the same shape. The registry change goes through the existing FSM action (`force-claim`) and the existing journal emitter, no new state.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It removes a silent drop. The only new authority is taking back a placement this same router created seconds earlier that the target refused or never acknowledged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The ACK values are an enumerable protocol (`queued | duplicate | stale-ownership | sender-rejected`), each mapped to the same meaning the forward path already gives it.

---

## 5. Interactions

- Durable inbound queue: the fallback uses the existing `queueMessage` with reason `spawn-<cause>`; the server's custody short-circuit handles acked rows as before.
- SpawnAdmission: after a reclaim the record names this machine as `active`, so local spawn is admitted under real ownership.
- OwnerSuspectBreaker: a target that never answered is marked suspect (as forwards do); one that answered is recorded responsive.
- Coherence journal: the reclaim is emitted as a `failover` placement with `prevOwner` = the refused target, so peers' appliers converge on this machine.
- `forceReplace` (queue maxAttempts escape): the second-pass review found that a re-place landing on THIS machine (self-placement, or a spawn taken back) returned `true` and the drain marked the row `delivered`, although production `handleLocally` is only a verdict and nothing delivered it. This was already true for self-placement before this change. `forceReplace` now returns a distinct `'local'`; the drain then runs ONE normal local dispatch under the claim it already holds and settles from that result. A retryable failure on that one attempt is terminal `attempts-exhausted` with the loss notice, so the escape stays bounded. The survivor re-place caller ignores the result (unchanged).

---

## 6. External surfaces

The mesh `deliverMessage` sent on placement now carries a real epoch and `senderEnvelope`. Old receivers ignore the extra field (same version-skew posture as forwards). A receiver now re-validates the sender on first placement as it already does on forwards.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine path itself. Ownership stays replicated through the coherence journal (the reclaim is journaled like any placement). One-voice is unchanged: the message is handled on exactly the machine the record names after the call.

---

## 8. Rollback cost

Revert the commit; no data migration, no config. Records reclaimed in the meantime are ordinary active records.

---

## Conclusion

Ships. Closes the "message arrives while ownership moves to a machine with an older record" loss; every remote-spawn outcome now ends with some session holding the message or an explicit refusal.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, fresh context)
**Independent read of the artifact:** concur (after one concern, resolved below; re-checked and concurred).

Round 1 raised one concern: on the drain's forced re-place, a take-back (or any self-placement) counted as `delivered` while `handleLocally` is a no-op in production, so no session got the message. The same flaw already existed for self-placement. Resolved in this change: `forceReplace` returns `'local'` and the drain delivers locally once (see §5). The reviewer judged the other points safe: double dispatch and ownership convergence (the take-back is journaled as a `failover` at a higher epoch), every live-path consumer of the new outcomes, and the real epoch plus sender envelope on the placement hop. Its noted behaviour change, sender re-validation now running on the first placement, is listed in §6.

---

## Evidence pointers

- Studio `logs/server.log` 2026-11-01T22:00:24.339Z route line; 22:09–23:39 stuck-recovery skips of `telegram:10000000001:1169`.
- `tests/unit/SessionRouter.test.ts` → "remote placement reads the spawn ACK" (incident replay with the real `createDeliverMessageHandler` at epoch 3).
- `tests/unit/session-router-spawn-ack-wiring.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Not a self-triggered controller: the take-back runs once per inbound message, on that message's own dispatch, with no loop or timer.
