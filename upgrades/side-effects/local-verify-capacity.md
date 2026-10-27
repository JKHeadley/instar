# Side-Effects Review — Local Verify peer verifiers (a second verifier machine)

**Version / slug:** `local-verify-capacity`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/local-verify-capacity.md` (converged: Codex rounds 1-4; approved by the operator's go-ahead in topic 130715). Part D only; Part C (batching) is rejected for v1. Operator request: merge throughput is top priority; use idle machines.

- `src/localVerify/peer.ts` (new): request parsing, `importRefusal` (the import rule), the per-peer breaker, `parsePeers`, the client seam, `PEER_LIMITS`.
- `src/localVerify/record.ts`: optional `attempt` field on a peer-produced record (validated; never on a `main` record). `orchestrator.ts`: copies `VerifyRunInput.attempt` onto the record.
- `src/localVerify/LocalVerifyService.ts`: peer side (`peerRun`, `peerStatus`, `peerResult`, `peerCancel`, `finishPeerAttempt`, `peer-attempts.json` with tombstones, interrupted attempts tombstoned at boot); coordinator side (`scheduleDispatch`/`dispatchOnce` with the base refresh and re-checks, the marker persisted before the send; `pollPeers` with import / reject / error / unknown / run-bound / lease-change handling; `abandonRemote`); reserved entries excluded from local selection, from derivation in `complete()`, from base updates in `request()`; a new head or closed PR abandons the attempt; import rechecks queue membership after the peer fetch; markers persisted and restored as written; `peers` in `GET /local-verify`; a peer-only mode that refuses every coordinator role.
- `src/localVerify/localVerifyRoutes.ts`: `POST /local-verify/peer-run`, `GET /local-verify/peer-status`, `GET /local-verify/peer-result`, `POST /local-verify/peer-cancel` (Bearer like every route).
- `src/localVerify/localVerifyWiring.ts`: peer-only build path (no source checkout + `peer.enabled`), `makePeerClient` (Bearer, 10 s timeout, failures → null), `wireLocalVerifyPeers`. `src/commands/server.ts`: wires them; a peer-only service gets no watcher, merge line or status loop.
- Agent awareness: template line + content-sniffed migration line.

## Decision-point inventory

- `dispatchOnce` — add — whether and what to hand to a peer. Deterministic; only while the coordinator's own slot is busy.
- `importRefusal` — add — whether a peer record may enter the coordinator's index. Deterministic, all-conditions.
- `peerRun` — add — whether the peer accepts. Deterministic.
- Merge decisions (§3 predicate, safe-merge, status projection) — pass-through, unchanged: an imported record is an ordinary record.

## 1. Over-block

- Every failed import check drops a possibly good record (the PR is then verified again). Accepted: the checks are exact by design.

## 2. Under-block

- A compromised peer can forge a success record that passes every check (it holds the same token and computes the same version hashes). Stated in the spec: the peer is a merge-authorizing principal inside the pool's existing trust boundary.
- Wall-clock checks assume pool clocks within minutes (the pool raises clock-skew alarms).

## 3. Level-of-abstraction fit

All decisions sit in the service that already owns the queue, the index and the single completion path; the peer reuses the same run child and orchestrator, so a peer record is produced by exactly the code a local one is.

## 4. Signal vs authority compliance

The peer never merges and never decides main health; its record has authority only after the coordinator's import check, which is the same authority a local record has.

## 4b. Judgment-point check

None added.

## 5. Interactions

- Main-red hold: held entries are never dispatched. Merge line: an imported success is handed to the merge watcher like a local one. Fail-fast / balanced shards (#2392 / #2393): apply on the peer too once both are on main.
- Restart hold: a peer run holds the peer's own restart like any run.
- Host test-runner bound: a peer run takes the peer's suite slot; the peer refuses as busy when a foreign suite holds it.
- Closed-PR race: a close observation dequeues and cancels a reserved attempt. A result fetch already in progress rechecks both the attempt marker and the entry's continued queue membership before import, so a late success cannot reach the merge line.

## 6. External surfaces

Four new routes (Bearer); `peers` in `GET /local-verify`; audit events `peer-*`; state file `state/local-verify/peer-attempts.json`; attention key `local-verify:peer-breaker:<machineId>`.

## 6b. Operator-surface quality

Nothing new to tap. The breaker item says in one sentence that the coordinator runs every verify itself for 30 minutes.

## 7. Multi-machine posture

This is the multi-machine piece. The queue and index stay machine-local; a lease move cancels outstanding attempts (no promotion).

## 8. Rollback cost

Remove the coordinator's `monitoring.localVerify.peers` (read live): nothing is dispatched; reserved entries are reclaimed by the poll (peer-not-configured). Turn off `peer.enabled` on the peer (read live): it refuses new work.

## Conclusion

Adds a second verifier with an exact import rule and bounded recovery; ships dark.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure `n/a`: dispatch and polling are bounded per entry (2 remote attempts, then local only), per peer (one outstanding attempt; a 3-failure breaker for 30 min), per run (60-minute bound) and run on the existing 30-second service tick; nothing re-triggers without a new queue entry.

## Second-pass review

The independent reviewer found a closed-PR race: a queued entry removed during a peer-result fetch could still be imported. The close path now cancels the attempt and persists the removal; the import path rechecks queue membership. A focused test closes the PR during the pending fetch and confirms the late success never enters the index or merge line. The reviewer rechecked the fix and concurred with the review, finding no other material concern in the signal and authority, lease, child lifecycle, or state retention paths.

CI then exposed a metadata mismatch: the peer attempt snapshot was registered as an append-only A-class stream, although it is rewritten in place with one current attempt, 20 results, and seven-day tombstones. The registry now describes that retention directly. Runtime state and its safety rules did not change.
