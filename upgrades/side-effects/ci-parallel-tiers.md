# Side-Effects Review — concurrent CI test tiers

**Version / slug:** `ci-parallel-tiers`
**Date:** `2026-11-01`
**Author:** Echo
**Second-pass reviewer:** independent merge-safety review — concurred

## Summary of the change

The `integration` and `e2e` GitHub Actions jobs no longer declare `needs: unit`. Each uses its own checkout, Node setup, dependencies, and runner. Required status checks and test commands remain the same. This is a reversible Tier-1 workflow scheduling change: two dependency lines removed, with comments added. One review round and one commit/gate attempt are planned.

## Decision-point inventory

- GitHub Actions job DAG — modified: integration and E2E may start with unit shards.
- Merge authority — unchanged: all required checks still must pass, and Local Verify remains independent.

## 1. Over-block

No PR gains a new block. A PR can still wait for the slowest of the three tiers or for GitHub runner capacity.

## 2. Under-block

No test or required check is removed. If a unit shard fails, integration and E2E now continue and consume runner minutes; their failures are visible rather than skipped. Branch protection must continue requiring the existing check names.

## 3. Level-of-abstraction fit

Job ordering belongs in `.github/workflows/ci.yml`. No test code or product runtime path needs a change.

## 4. Signal vs authority compliance

Per [signal-vs-authority](../../docs/signal-vs-authority.md), faster job scheduling does not grant merge authority. A full green CI result and the independent local verifier still gate the merge.

## 5. Interactions

The unit matrix runs eight jobs. Starting two more jobs at once can compete for the repository's GitHub runner allotment, so the wall-time gain depends on available runners. Each job has its own filesystem and install. The `build` and optional `contract` jobs retain their current unit dependency; this change targets the two long test tiers on the critical path.

## 6. External surfaces

GitHub checks begin in a different order and may use more runner minutes on a PR with failing units. Check names, branch-protection requirements, published packages, and user-facing APIs are unchanged.

## 7. Multi-machine posture

GitHub-hosted jobs run outside the Studio, Mini, and M5. This change does not alter their local suite limits, peer dispatch, or ownership records.

## 8. Rollback cost

A normal revert restores the prior serial CI job graph. There is no state migration or data cleanup.

## Verification and proportion

Validate the workflow parses, and compare the parsed job definitions before and after except for the two intended `needs` edges. A PR run must show integration and E2E scheduled before unit completion, and all required checks green. The observed gain is a CI wall-time measurement, not a promise about every run because runner contention varies.

## Second-pass review

**Reviewer:** Independent CI scheduling reviewer

Concur with the review. The reviewer confirmed that integration and E2E use separate runners, checkouts, and installs; E2E builds its own artifacts. `scripts/safe-merge.mjs` still inventories both tiers and every unit shard by check name. Runner contention and extra minutes on unit-red PRs remain the measurable costs. Live scheduling and branch-protection behavior require a PR run to verify.
