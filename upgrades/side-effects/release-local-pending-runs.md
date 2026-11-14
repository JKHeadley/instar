# Side-Effects Review — Local release counts pending publish runs

**Version / slug:** `release-local-pending-runs`
**Date:** 2026-11-03
**Author:** Echo
**Second-pass reviewer:** independent subagent review (see below)

## Summary of the change

`activePublishRuns` in `scripts/lib/release-local-steps.mjs` adds one unfiltered `gh run list --workflow publish.yml --limit 100` query and counts every run whose status is not `completed`, deduplicated with the existing per-status results. This closes a gap where a run in GitHub's `pending` state (waiting behind another run in `concurrency: publish`) was invisible, so cancelling only the reported queued run would admit the pending one to race a local publish. Tier 1: one function, 2 files of code (about 5 lines of source, 25 of test); spec-driven by the approved `docs/specs/local-release.md`, which already requires refusing while "any publish.yml run on the repo is unfinished". Effort: one build, one targeted test run (95/95), a live before/after check.

## Decision-point inventory

- Local release preflight and pre-publish publish.yml check — modified: the set of runs counted as active grows; the stop/proceed rule (`ciGateAction`) is unchanged.

## 1. Over-block

A run in an unfinished state that cannot actually publish (for example a stuck `pending` run that will be superseded) now stops a local release until it is cancelled. That is the intended conservative direction: the spec says unfinished runs block, and cancelling a not-started run is cheap.

## 2. Under-block

A pending run older than the 100 most recent publish runs would still be missed by the new query. Publish concurrency allows only one pending run, and it is always among the newest, so this is not reachable in practice. A run created after the final check but before the npm publish still races; that window existed before and is unchanged.

## 3. Level-of-abstraction fit

Correct layer: the single function both checks (preflight and pre-publish) call. No other caller.

## 4. Signal vs authority compliance

Deterministic safety floor on an irreversible action (npm publish). It widens what counts as an existing exact fact (an unfinished run), adds no brittle detector, and an unknown answer stays a stop. See [signal vs authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

None. Run status is an exact field.

## 5. Interactions

`ciRunState` already treated any non-`completed` status as active; the new query reuses it. The test asserting one query per active status now filters to status queries and asserts exactly one unfiltered query. One extra GitHub API call per check.

## 6. External surfaces

Read-only GitHub queries only. The operator-visible change is that the refusal message lists the pending run id too.

## 6b. Operator-surface quality

The refusal message and its cancel instruction now name every run that must be cancelled, instead of one that leads to a second surprise.

## 7. Multi-machine posture

Machine-local by design: whichever workstation runs the release queries the shared GitHub authority directly.

## 8. Rollback cost

Revert the commit. No state, no migration.

## Second-pass review

(appended below)

Concur with the review. Independent reviewer (separate subagent, read-only, live `gh run list` check, 2026-11-03T01:56Z): the pending/queued pair was confirmed live; duplicates are listed once; a failed or unreadable recent-runs query yields unknown, never clear; under `concurrency: publish` with `cancel-in-progress: false` at most one run is pending and it is always among the newest, so the 100-run window cannot miss it; only `completed` runs are excluded, so nothing is wrongly blocked; no existing safety property is weakened; the tests exercise the new query directly.
