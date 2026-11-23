# Upgrade Guide — Merge Actions Fixture Isolation

<!-- internal-only -->
<!-- bump: patch -->

## What Changed
The Actions-contract merge-check integration fixture explicitly selects the existing Actions verification mode in its child environment. It no longer inherits a hosting agent’s local-verification setting. Production merge policy is unchanged.

## Evidence
All six Actions-contract and eighteen local-floor integration tests passed together. Missing Actions checks still refuse the fake merge; local-mode record requirements remain covered separately. Complete normal verification remains required before merging history-import updates.
