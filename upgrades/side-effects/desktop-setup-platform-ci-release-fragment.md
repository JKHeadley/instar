# Side-Effects Review — CI repair release fragment

**Version / slug:** `desktop-setup-platform-ci-release-fragment`
**Date:** 2026-11-02
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change

Add an internal-only release-note fragment for the previously reviewed CI and test repair. No executable code, workflow or test assertions change in this commit.

## Decision-point inventory

No runtime decision point changes. The release assembler reads the fragment and the pre-push gate verifies its presence.

## 1. Over-block

No new input is rejected. A malformed fragment could fail release lint, so this file follows the existing internal-only fragment format.

## 2. Under-block

This fragment does not prove the revised PR head's GitHub or independent verification. It explicitly states those gates remain required after publication.

## 3. Level-of-abstraction fit

The release note belongs in `upgrades/next/` because the CI workflow is release-relevant. It introduces no competing-signals heuristic.

## 4. Signal vs authority compliance

The fragment is descriptive evidence for release assembly, not a runtime authority. The pre-push gate remains the deterministic authority for requiring a fragment, consistent with `docs/signal-vs-authority.md`.

## 5. Interactions

The internal-only marker lets the assembler omit user-facing sections for this no-runtime-surface change. The fragment is not intended to be used as a test receipt.

## 6. External surfaces

Release notes will describe the CI/test repair. No user-facing product behavior, API, message, credential or network destination changes.

## 7. Multi-machine posture

The note ships in the repository and is shared with every build; it creates no machine-local state or topic behavior.

## 8. Rollback cost

Revert the fragment with the CI repair if the PR is reverted. No data migration or agent state repair is needed.
