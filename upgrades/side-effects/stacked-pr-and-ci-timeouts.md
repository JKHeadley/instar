# Side-Effects Review — stacked PRs are never merged or shown clean; every CI job has a timeout

**Version / slug:** `stacked-pr-and-ci-timeouts`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`
**Tier:** 1 (small, reversible by one revert; only adds refusals, skips and time limits). Change size: 2 workflow files, 3 source files, 5 test files, 3 docs. Effort: one design pass, no spec rounds.

## Summary of the change

Two evolution actions on the CI/merge path.

**ACT-053.** `ci.yml` runs on `pull_request: branches: [main]` and the main ruleset's required checks apply only to main. A PR whose base is a feature branch (a stacked PR) therefore runs no suite on GitHub and shows mergeStateStatus CLEAN. Of the last 400 merged PRs, one (#2202, 2026-10-19) merged branch-to-branch.

Options weighed:
- (a) widen ci.yml's filter: every push to every stacked PR runs all 13 jobs (8 unit shards), then again after retarget. On an Actions allowance measured saturated (ci.yml concurrency notes: a single PR took hours), that roughly doubles stack cost. Rejected on capacity.
- (b) required checks on every base: a repository ruleset setting, not a reviewable file; with no suite running on those bases it would leave stacked PRs pending forever with no explanation. Rejected.
- (c) refuse merges into a feature branch, retarget to main first. Zero extra suite runs; stacks are still reviewed in place and verified exactly once against main. **Chosen.**

How the existing merge paths treat a non-main base today (checked before choosing):
- `safe-merge --admin` (actions floor): refuses already, because the e2e check never ran (`refused:e2e-missing-or-red`). Safe, but for the wrong stated reason.
- `safe-merge --auto`: refuses only when zero Actions checks ran. Any non-main-scoped workflow running (as eli16/ux-impact did on #2142) lets it arm, and with nothing required on that base GitHub merges at once. **Hole.**
- Local floor (`safe-merge` sync path with `floor: local`, configured on this agent): Local Verify keys records by (pr, head, base) and will verify a PR against its feature base on request; the record then admits a merge INTO the feature branch. The content is tested, but the merge is not a landing on main and reports "merged".
- `StatusReconciler` (local-verify GitHub status mirror) already only posts for `baseRefName === 'main'`.
- Green-PR watcher: on the local floor, a stacked PR with a record is a candidate.

Change:
1. `scripts/safe-merge.mjs`: `nonMainBaseRefusal(baseRefName)` (pure, exact match on `main`); `main()` exits `refused:non-main-base` right after the draft check, before `--auto`, floor selection and any check read. New capabilities feature `non-main-base-refusal`.
2. `.github/workflows/stacked-pr-guard.yml`: `pull_request` with `branches-ignore: [main]`, types opened/edited/synchronize/reopened; one step, no checkout, `timeout-minutes: 2`, prints an `::error::` with the retarget command and exits 1. The base name reaches the shell through `env`, never inline.
3. `src/monitoring/greenPrLogic.ts`: `isStackedPr(pr)` (known, non-empty, not `main`); `classifyCandidate` skips `non-main-base` first after ownership.
4. `src/monitoring/GreenPrAutoMerger.ts`: the red-PR watchdog treats a stacked PR as not stuck (it is red by design from the guard).

**ACT-059.** No ci.yml job declared `timeout-minutes`, so all inherited the 6-hour default. Measured 79 completed ci.yml runs (2026-11-02): slowest unit shard 29.6 min, integration 24.4, e2e 34.9, desktop packages 3.9, every other gate at most 2.3. Limits set at about twice the slowest: unit 60, integration 50, e2e 70, all others 15. A header comment in ci.yml records the measurement.

## Decision-point inventory

- `safe-merge` main(): new refusal `refused:non-main-base` (deterministic base-name fact).
- `classifyCandidate`: new skip `non-main-base` (more conservative only).
- `redPrWatchdogPass`: stacked PRs no longer raise stuck-red attention (signal suppression for a known-by-design red).
- GitHub: a new non-required check that is always red on stacked PRs; ci.yml job time limits.

## 1. Over-block

- A deliberate branch-to-branch merge through safe-merge is refused. No such merge is part of any flow here (1 in the last 400, and that one is the incident). A human can still merge on GitHub; the red guard check tells them why not to.
- A job legitimately exceeding its limit (e.g. the suite grows ~2x) fails and must be re-run or the limit raised. Margin is ~2x the slowest of 79 runs; the header comment says to raise it when the job genuinely grows.
- Runner queue time does not count toward `timeout-minutes` (it starts when the job starts on a runner), so the saturated allowance cannot cause false timeouts.

## 2. Under-block

- A human clicking Merge on GitHub on a red stacked PR is not prevented: the guard is not a required check (making it required is a ruleset change, option b). The badge is no longer CLEAN, which is the reported defect; every agent merge goes through safe-merge.
- After a stacked PR is retargeted to main (by hand, or by GitHub when the bottom PR's branch is deleted), ci.yml does not fire on the base change alone (`edited` is not in its types). Until a push or close/reopen: `--admin` refuses (`e2e-missing-or-red`); `--auto` is NOT refused by `no-checks-ran` (the stale guard run is an Actions check) and may arm, but GitHub then waits on main's required checks, which have not run, so nothing merges; the local floor needs a new record for the main base. Safe in every case, and both the refusal text and the guard's error now say to push or close/reopen after retargeting.
- The stale red guard check stays attached to a head SHA after retarget until a new push. It never adds a block that was not already there: that same head has no ci.yml run against main either.

## 3. Level-of-abstraction fit

safe-merge is the single act-time merge authority for agents (MergeRunner and the watcher both call it), so the refusal belongs there. The watcher skip is a signal-level filter in front of it, mirroring the `no-checks-ran` precedent (PR #2307). The GitHub-visible signal belongs in a workflow because the reported defect is what GitHub shows.

## 4. Signal vs authority compliance

The refusal holds blocking authority, but on a deterministic fact (the base ref name equals `main`), not a heuristic, and it can only produce "do not merge". Same pattern as `refused:draft` and `refused:no-checks-ran`. The watcher changes only skip or silence; they never cause a merge.

## 4b. Judgment-point check

No competing-signals judgment. Hard floor: a feature-branch base is never a landing.

## 5. Interactions

- `MergeRunner` passes `refused:*` through. The watcher skips stacked PRs before calling it, so the ladder is not consumed.
- Local Verify: unchanged; it may still verify a stacked PR on request (useful as an early signal); safe-merge simply will not merge it into the feature branch.
- `eli16-pr-gate`, `ux-impact-pr-gate`, `class-closure`, `decision-audit` remain main-only; unchanged.
- ci.yml concurrency block and test (`ci-workflow-concurrency.test.ts`) unchanged.
- Red-PR watchdog: a stacked PR previously raised could be cleared via the existing "recovered" path; harmless.

## 6. External surfaces

One new result string (`refused:non-main-base`), one new capability feature, one new candidate skip, one new GitHub check name ("Stacked PR — retarget to main before merging") on non-main-base PRs only, and job time limits. Open stacked PRs (#1930–#1939, phaseb) will show the red guard on their next push or edit. No config, routes or state.

## 6b. Operator-surface quality

The refusal and the check text both state the one action to take, with the exact command. No new attention items; one fewer kind (stacked PRs no longer raise stuck-red).

## 7. Multi-machine posture

Machine-local by design: safe-merge runs where invoked; the watcher runs on the lease holder. Both read GitHub, the shared truth. Workflows run on GitHub.

## 8. Rollback cost

Revert the commit. No state, migration or config.

## Conclusion

Option (c) closes the hole at zero CI cost; time limits close the 6-hour hang. Ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-11-02
**First read: concern raised (accuracy only, no merge-safety defect).** (1) The refusal and guard texts said "retarget, let CI run", but ci.yml does not fire on a base change, so CI would never start. (2) The under-block bullet wrongly claimed `no-checks-ran` refuses a retargeted, unpushed head on `--auto`; the stale guard run is an Actions check, so `--auto` can arm, though GitHub still waits on main's unrun required checks and nothing merges. Both fixed: the texts now say to push or close/reopen after retargeting, and the under-block bullet is corrected. The reviewer confirmed: the refusal precedes head pin, floor choice, `--auto` arming and any `gh pr merge`; no caller merges into a non-main base or uses a repo with another merge branch; the guard YAML is valid and injection-safe (`env` only, `permissions: {}`); all 12 ci.yml jobs have timeouts at ~2x the measured slowest; `isStackedPr` cannot match a main or absent base; the tests would fail without the fix.

## Evidence pointers

- `tests/integration/safe-merge-non-main-base.test.ts`: real script, fake `gh` recording calls: stacked PR → exit 1 `refused:non-main-base` on `--auto` and `--admin`, only the PR read happened, no `gh pr merge`; a main PR passes the base check.
- `tests/unit/safe-merge-non-main-base.test.ts`: pure refusal (exact match, unreadable base refused), capabilities.
- `tests/unit/ci-workflow-timeouts.test.ts`: every ci.yml job has 1–120 min; heavy jobs keep headroom; ci.yml stays main-only; guard workflow shape and env-only base name.
- `tests/unit/green-pr-logic.test.ts`, `tests/unit/green-pr-red-watchdog.test.ts`: watcher skip and silence, base-scoped.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a CI/merge-path defect; the new tests are the regression guard).
