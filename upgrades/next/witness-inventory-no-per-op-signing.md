# The witness inventory no longer signs a proof for every stored change

<!-- bump: patch -->

## What Changed

`GraphWitnessService.recoveryManifest` (the source manifest inside every witness inventory, built on each readiness pass and on peer inventory requests) loaded each stored operation through `operation()`, which signs a witness state proof for the operation — about ten canonical hashes and an Ed25519 signature — and then threw the proof away. At ~565 operations that held the event loop 1-4 s per inventory on the accept-all rig (2026-11-18). `operation()` is now split into a private `operationState()` (the same reads and the same verification, each failure throwing as before) and the signed proof on top; the manifest uses `operationState()`. `operation()`'s output is unchanged.

## What to Tell Your User

- **Faster record checks**: "A check I run on my records of saved changes no longer signs a receipt for every change just to throw it away, so it finishes much faster."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Witness inventory built without per-operation signing | Automatic |

## Evidence

Rig CPU profile (2026-11-18 04:32Z): `exportInventory` 8-15% of the long event-loop stretches, of which `recoveryManifest` → `operation()` ~89%. Test: `tests/unit/graph-witness.test.ts` ("builds the inventory manifest without signing a state proof per stored operation, with the same entries"); witness suites 4 files passed.
