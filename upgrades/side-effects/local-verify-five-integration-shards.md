# Side-Effects Review — a fifth integration test process

**Version / slug:** local-verify-five-integration-shards
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** Independent Codex reviewer

## Summary of the change

Tier 1. The existing per-machine integration process setting accepts five. The staged change is small and reversible. One targeted review pass checked the service and runner limits, defaults, migration, and test-file coverage. The first commit attempt identified the missing review artifact and trace.

## Decision-point inventory

The runner and service share a maximum for each lane and fall back to existing defaults on an invalid override. A documentation migration updates the old setting range in agent guides.

## 1. Over-block

The accepted integration range expands by one. The runner accepts all counts it previously accepted.

## 2. Under-block

An operator can choose five on a machine where it increases resource contention. The existing host protections still apply, and the trial needs live wall-time and failure measurements.

## 3. Level-of-abstraction fit

The service validates the live run input and the runner validates inputs from its other callers. Both read the same lane limits.

## 4. Signal vs authority compliance

There is no new blocking authority. The numerical range defines a configuration value. Merge evidence still comes from the existing verification result. [Signal vs authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

There is no new static heuristic at a competing-signals decision point.

## 5. Interactions

The runner uses one configuration snapshot per run. Its existing assignment code partitions the same file set across the configured process count. Report joins still check for missing and repeated files. An extra configured process increases peak resource use.

## 6. External surfaces

The agent guide documents the expanded setting. The migration updates matching guide lines idempotently. No operator interface or status response shape changes.

## 7. Multi-machine posture

The setting is machine-local by design because capacity differs by machine. There are no new notices, links, or persistent run records.

## 8. Rollback cost

Return the integration count to four for the next run. Reverting the code restores the old upper limit. No recorded verification state requires repair.

## Evidence

Seven targeted service and runner tests and three agent-guide tests passed. A TypeScript check and the normal commit checks verify the updated code. The five-process result is a planning estimate until a live comparison is complete.

## Second-pass review of the opt-in trial

**Reviewer:** Independent Codex reviewer, read-only subagent

An independent read-only reviewer checked commit `784dd9596`. Verdict: **concur**. The service and child use the same integer and per-lane limits. Existing valid settings and defaults are preserved. Five processes use the same file partition, first-part exclusion, deadlines, coverage checks, and failure handling. The agent-guide migration is narrowly scoped to the previous wording and is idempotent. The merged diff passes git's whitespace check. This review establishes correctness of the setting path. Wall time and resource contention require the live comparison.
