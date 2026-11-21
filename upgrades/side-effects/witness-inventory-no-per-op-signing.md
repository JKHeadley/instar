# Side-Effects Review — witness inventory manifest built without per-operation signing

**Version / slug:** `witness-inventory-no-per-op-signing`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `independent general-purpose subagent — concur`

## Summary of the change

Tier 1 (a revert fully undoes it). One source file + one test addition. `GraphWitnessService.operation()` is split into a private `operationState()` (every read and every verification, each failure throwing exactly as before, returning the state without the signed `stateProof`) and `operation()` = `operationState()` + the unchanged signed proof. `recoveryManifest()` uses `operationState()`: it and `recoveryEntry()` read only packet, certificates, receipts and the proof-object hashes, never `stateProof`. Each inventory therefore no longer signs and discards one witness state proof per stored operation (~10 canonical hashes + an Ed25519 signature each; 1-4 s per inventory at ~565 operations on the loaded rig).

## Decision-point inventory

No decision changes: the manifest's contents and every verification are unchanged.

## 1. Over-block

No block/allow surface.

## 2. Under-block

No block/allow surface. Every check `operation()` made still runs in `operationState()` for every row the manifest reads.

## 3. Level-of-abstraction fit

Right layer: the manifest asked for more than it used.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

`signed()` and `timestamp()` have no side effects (`timestamp` reads the injectable clock). Callers of `operation()` (recover, transfer, peers) get the identical object.

## 6. External surfaces

None. The inventory is still signed; per-operation proofs are produced only where callers ask for them.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local computation on the witness's own database; replicated inventory content unchanged.

## 8. Rollback cost

Revert; no state.

## Conclusion

Ship as Tier 1, folded into #3369 (same stall-reduction theme) at the merge line's request.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only), 2026-11-18 05:16Z
**Independent read of the artifact: concur**

Same reads in the same order (row, control capsule, writer, erasure rows) and the same three checks throwing in the same order (`operation-control-evidence-missing`, `operation-control-membership-evidence-missing`, `operation-signature-evidence-missing`); `row` narrowing intact. `recoveryManifest`/`recoveryEntry` never read `stateProof`. `operation()`'s literal is unchanged incl. key order and `observedAt`. `signed()` is a pure signing call and `timestamp()` only reads `this.now()`; manifest callers use entries or hash the manifest, which never included per-operation proofs; inventory and export still sign their own envelopes.

## Evidence pointers

- Rig CPU profile 2026-11-18 04:32Z: `exportInventory` 8-15% of long stretches; `recoveryManifest` → `operation()` ~89% of it.
- Tests: `tests/unit/graph-witness.test.ts` (24 passed incl. the new case), witness suites 4 files / 41 passed before the addition.
