# Local Verify: the slow test lanes run as more, evenly balanced processes

## What Changed

- `src/localVerify/policy.ts`: the integration lane runs as 2 processes (`integrationShards`, new, in the policy hash) and the e2e lane as 3 (`e2eShards` 2 → 3).
- New `src/localVerify/shardPlan.ts`: each shard of a lane gets an explicit file list planned from the per-file times of earlier runs (longest first onto the least-loaded shard), with files whose paths contain one another kept together; below 50% history coverage the lane uses vitest `--shard=k/n`.
- `src/localVerify/laneReport.ts`: per-file wall time is kept from vitest's report; `orchestrator.ts` writes the integration/e2e times to `<verifyRoot>/file-durations.json` (read only at ≤ 2 MB).
- Live setting `monitoring.localVerify.laneShards` (`{integration, e2e}`, 1..4 each, read at each start) for a no-restart return to the old split. Agent awareness line + migration.

## What to Tell Your User

Nothing changes for an ordinary agent. For maintainers who run Local Verify: each pull request test run should take roughly half as long, because the two slow test groups now run as more parallel pieces of equal length. If the machine struggles with the extra processes, one setting restores the old split.

## Summary of New Capabilities

- Balanced test shards for Local Verify, with the live setting `monitoring.localVerify.laneShards`.

## Evidence

Step medians 2026-10-20..26 (Studio run logs): unit 7.3 min, integration 15.7, e2e shards 9.3 and 16.8. Simulated on kept reports, balanced: integration 2 × 5.3 min and e2e 3 × 2.3 min of test time plus per-process start-up. Unit: `tests/unit/localVerify/` (orchestrator incl. balanced plan, overlap grouping, oversized history, setting fallback; shardPlan; laneReport durations; service setting) green; migrator awareness 10/10; e2e lifecycle covers the live setting through the production wiring. Independent Codex review: round 1 BLOCKED (3 findings, fixed), round 2 CLEAN.
