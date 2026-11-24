# Draft Design Gate Foundation

## Summary

Tier 2 checkpoint for the unfinished design gate. This branch preserves the existing parser, registries, renderer and Accounts harness work with its tests. The approved design specification is in docs/specs/design-standard-enforcement.md. The draft is for preservation and review of the checkpoint.

## Over-block

Changes to Local Verify and filesystem support need full review before merge. Existing production read routes share extracted implementations with the Accounts harness. Any behavioral change in those routes could affect dashboard callers, so full compatibility is still pending.

## Under-block

Current test fixtures and source checks cover parts of the design standard. A complete gate run, native captures and rollout approval are outside this checkpoint.

## Level Of Abstraction

The registry and validators live in src/designGate. The test renderer and sample Accounts data live under tests/design. Local Verify retains evidence custody. Review should trace each shared read path through its regular HTTP entry point.

## Signal Versus Authority

The branch preserves the current evidence machinery. Design enforcement remains held. Evidence from synthetic accounts does not authorize deployment or release.

## Interactions and Multi-Machine Posture

The source touches the renderer and its subprocess cleanup, filesystem wrappers, Local Verify, and the shared Accounts and browser status routes. Keep the branch in a draft with a hold before any merge queue or deployment. No operational action against other machines is part of this snapshot.

## Rollback

Leave the draft unmerged. If any slice is later accepted, follow its reviewed rollout and revert plan.

## Evidence

This is a checkpoint of previously started work. Earlier focused receipts are recorded in the private continuation notes. The whole candidate still needs a fresh integration review and full verification. Published evidence should use synthetic fixtures and code only.
