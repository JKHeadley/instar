# Side-Effects Review — local-verify runs its lanes at once, inside one suite slot

**Version / slug:** `local-verify-parallel-lanes`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see bottom)`
**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), two rounds, concurred in round 2

## Summary of the change

The local verifier ran its three test lanes one after another (about 4 + 15 + 23 minutes), one verify at a time, so a queue of five PRs meant the last waited about three hours. This change runs the lanes at once:

1. `src/localVerify/orchestrator.ts`: after the single foreign-suite check, the run takes ONE full-suite slot through a new seam `holdSuiteSlot()` and holds it for the lane phase; all lanes start together (`Promise.allSettled`), each lane's isolation re-run follows that lane. `e2e` runs as `LOCAL_VERIFY_LIMITS.e2eShards` (2) vitest shards whose reports are merged before the inventory rule. Each lane process gets its own `TMPDIR` and `TMUX_TMPDIR`; the unit lane runs with `INSTAR_TEST_WORKERS=4`. A busy slot re-queues (`foreign-suite-at-start`); the wait-in-place before lanes 2/3 is removed (no later lanes); the slot is released in `finally`.
2. `src/localVerify/orchestratorSeams.ts`: the real `holdSuiteSlot` acquires `{lane:'suite', runClass:'background', budgetMs: 60s}` from the host bound. Capacity timeout, storm ceiling or an internal error → `'busy'` (re-queue); fail-open admit → `null` (lanes run; their own requests fail open the same way).
3. `src/localVerify/policy.ts`: `e2eShards: 2` (in the policy hash, so earlier records do not match the new policy); the unit lane deadline 10 → 20 min, for the bound's 4-worker clamp on nested runs.
4. Spec amendment (§1 "Parallel lanes in the verifier", Decision 2, single-flight paragraph) and ELI16 update.

## Decision-point inventory

- Verify single flight — modify — one check before the lanes, then a held slot; the in-place wait is removed.
- Lane verdict — modify (shape only) — a lane's report is the union of its shards; a missing shard report is a missing lane report (the inventory rule fails the run, as before); a non-zero or signal exit of any shard is the lane's exit code.
- Isolation re-run budget — unchanged rule; the shared budget is now read and spent with no await in between, because lanes finish concurrently.

## 1. Over-block

- A verify that finds the slot busy re-queues instead of waiting in place. Before, a foreign suite seen before lane 2/3 waited up to 30 min in place. Now the verify re-queues at start only; it never holds a worktree while waiting. No new refusal of a passing PR.
- Unit lane clamped to 4 workers when nested: slower (measured 7 min under extra load, budget raised to 20). If a much larger unit suite outgrew 20 min the verify would error `deadline:unit`, never pass wrongly.

## 2. Under-block

- Merged shard reports: if both shards somehow ran the same file, the merge keeps one entry (Map set). Vitest's `--shard` partitions files disjointly; the inventory rule still requires every file in exactly one lane's report with zero failures.
- A shard killed by a signal after writing its report: its exit code is null, and a null exit with a full report is not by itself a failure — the same behaviour the serial lane had (`lane-exit-nonzero` needs a number). A killed process does not normally write its JSON report, so the missing report fails the run (tested).
- Fail-open slot (`null`, only for a fail-open admit): the lanes' own requests fail open the same way, so they do not wait on each other. An internal error re-queues instead.

## 3. Level-of-abstraction fit

Concurrency lives in the orchestrator, which already owned lane order, env and deadlines. Slot holding goes through the bound's public `acquire`/`release` and its existing nested-run rule (ancestry), so no new capacity mechanism was added. The shard count is a policy constant next to the lane deadlines.

## 4. Signal vs authority compliance

No new judgment gate. The verify's pass/fail authority is unchanged: the same inventory rule over the same files. The slot is a capacity limiter (mechanical counts), unchanged in kind.

## 5. Interactions

- Host test-runner bound: one held suite slot for the whole lane phase; nested lane runs are clamped to ≤4 workers by the bound. Other full suites on the host still wait for that slot — exactly as when a lane held it. Total workers ≤ 7.
- A busy slot is found after fetch, install, build and lint, so a re-queue for a busy slot costs that work (about 10–15 min) again on the next try. Bounded (the service checks holders before every start; the starved signal covers a slot that stays busy). Taking the slot earlier would hold it through the build. Accepted.
- Integration lane's port-reuse race: stays one process, one worker; unaffected.
- e2e tmux cleanup helpers: each shard has its own tmux server via `TMUX_TMPDIR`; `resume-follows-account-dead-pane-e2e` already uses its own `-L` socket. No test kills by process name across runs (grep for pkill/killall: none).
- `LocalVerifyService` in-place wait accounting (`inPlaceWaits`) now over-estimates the run ceiling (no in-place waits happen). Harmless: the restart hold is a little longer than needed. Left as is to keep the change small.
- Measured on `main` 70dce25 on the Studio with a serial verify running alongside: lanes ≈ 20 min vs ≈ 42 serial; 58,373 tests, one load-sensitive test failure, fixed separately in PR 2319.

## 6. Rollback

Revert the commit. Records made under the new policy hash then stop matching and those PRs are re-verified under the old policy (the policy hash covers `e2eShards` and the deadlines), which is the existing behaviour for any policy change.

## Second pass

Round 1 (independent subagent, 2026-10-22): **did not concur**. Blocking: (1) `Promise.all` over shards let a shard deadline settle the lane while the sibling shard was still running, so cleanup and slot release could orphan it; (2) the shard exit merge picked a signal exit (null) over a sibling's numeric non-zero exit, hiding an unhandled-error exit. Should-fix: duplicate files across shards overwrote silently; the 7-worker claim held only while the bound enforces; a fail-open `null` slot made four lanes compete for one cap-1 slot; two spec paragraphs contradicted the code; missing tests for the shard rules. Nits: no overlap entry on a busy slot; stale registry reason text; `deadline:e2e-N` naming and "alone within its lane" not stated.

Fixed: `allSettled` over shards and lanes (every process exits before the lane settles; tested by a slow sibling shard); numeric non-zero exit wins (tested); a duplicate file makes the lane report missing (tested); the unit lane's workers pinned with `INSTAR_TEST_WORKERS=4` (tested); an internal bound error now re-queues (`busy`), only a fail-open admit runs without a slot; spec "Single flight" and "Slots and timing" rewritten, shard naming and re-run scope stated; overlap entry on a busy slot (tested); registry reason updated. Round 2: **concur**; nits fixed (stale watch-only sentence, busy overlap records the live holders, re-queue cost stated in §5). Left: `LocalVerifyService`'s in-place-wait padding of the restart ceiling (harmless, stated in §5).
