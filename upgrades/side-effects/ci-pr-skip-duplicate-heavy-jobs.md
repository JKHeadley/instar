# Side-Effects Review — pull requests skip the heavy CI jobs that Local Verify already runs

**Version / slug:** `ci-pr-skip-duplicate-heavy-jobs`
**Date:** `2026-11-21`
**Author:** `echo (session echo-increasing-throughput)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. Two workflow files, one script, one runtime source file (`src/feedback-factory/execute/FeedbackExecutorService.ts`, a two-line mapping) and two tests. In `.github/workflows/ci.yml` each of the five heavy jobs (the unit shard matrix, integration, e2e, the Windows and Mac desktop packaging jobs) gains `if: github.event_name != 'pull_request' && github.event_name != 'pull_request_review'`; `contract` and `build` follow through `needs: unit`; the comment above `concurrency:` records why and the older paragraph about review-triggered runs is reconciled with it. In `scripts/safe-merge.mjs`, `--auto` now honours the selected floor: under the `local` floor it takes the local path (new `resolveFloorSelection` and `autoTakesActionsFloor`), because the feedback executor always calls `--auto` and would otherwise wait on Actions checks that no longer run on pull requests. `.github/workflows/publish.yml` loses a stale comment that claimed ci.yml gates pull requests through branch protection. `tests/unit/safe-merge-auto-local-floor.test.ts` is new. Effort: three review rounds (five concerns in all, each fixed), two commit attempts. More than a Tier-1 change usually needs; each round found a real consequence for a merge path, which is what the review is for. The only runtime `src/` change is that executor mapping.

## Decision-point inventory

- `GitHub Actions job gating in ci.yml` — modify — the heavy jobs no longer start on pull request events; they still run on push to main and workflow_dispatch. This is not an agent decision point: it decides which GitHub jobs run, not what an agent may do.

---

## 1. Over-block

No block/allow surface on agent behaviour. The only thing newly withheld is a GitHub job on a pull request; the same job still runs on main. A contributor who relied on reading the GitHub unit-shard result on a pull request now reads the Local Verify status instead, which already covers the same tests.

---

## 2. Under-block

A test that passes on Node 24 (what Local Verify runs) and fails only on Node 20 or 22 (GitHub's matrix) is now caught on the push to main instead of on the pull request. That makes main red for one release cycle rather than keeping the change out. The main run is kept precisely so this is still caught.

---

## 3. Level-of-abstraction fit

Right layer. The duplication lives in the workflow file, and the fix is a job condition in that file. The alternative, deleting the jobs, would lose the main-branch coverage; the alternative of changing the merger to ignore GitHub is already the case under the local floor.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

A skipped GitHub job reports success to GitHub, but none of the skipped jobs is a required status check: the main ruleset requires only `instar/local-verify`. The merge authority remains Local Verify plus the green-PR merger's local floor.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The event-name test is an enumerable invariant: pull request events skip, everything else runs.

---

## 5. Interactions

- `scripts/safe-merge.mjs` pins the heavy job names in `ACTIONS_FLOOR_CONTEXTS`. Under the configured `floor: local` the green-PR merger runs the synchronous local path and never reads them. The feedback executor (`src/feedback-factory/execute/executorPorts.ts`) always calls `--auto`, which before this change took the Actions path regardless of floor and would have refused every merge once the heavy jobs skip (`refused:e2e-missing-or-red`, because a skipped job reports `skipping`, never `pass`). Fixed here: `--auto` under the `local` floor falls through to the local path. Two consequences, both from the second review round: (a) when the agent config file exists but is unreadable and no `INSTAR_MERGE_FLOOR=actions` override is set, `--auto` now refuses `refused:verify-record-unmeasurable` instead of going straight to the Actions checks, which fails closed; (b) on the local path, a head with no Local Verify record yet answers `refused:verify-pending`, which the feedback executor used to treat as a failed attempt (one retry an hour later, then parked); `FeedbackExecutorService` now treats `verify-pending` like `deferred:checks-pending`, waiting on its five-minute cadence under the same three-hour deadline, with a unit test for the mapping. If the floor is ever switched back to `actions`, every pull-request merge through safe-merge is refused, not merely deferred, which fails closed; restoring the heavy jobs on pull requests must accompany such a switch.
- `tests/unit/ci-workflow-concurrency.test.ts`, `floor-drift-canary.test.ts`, `safe-merge-hardening.test.ts`, `standards-coverage-ratchet.test.ts` and eight other files read ci.yml; all 365 tests in those twelve files pass with the change.
- The `concurrency` block and `cancel-in-progress` rules are unchanged.

---

## 6. External surfaces

Visible to anyone reading a pull request's checks on GitHub: the heavy jobs show as skipped. No agent, user or external system reads those job results; the green-PR merger reads the Local Verify commit status.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design and not agent state: it is repository CI configuration, read by GitHub. No replication, no status surface.

---

## 8. Rollback cost

Revert the single commit. GitHub applies the restored workflow to the next push. No data, no agent state, no release artefact changes.

---

## Conclusion

Approved to ship as Tier 1 after the second-pass concerns were fixed. The change removes duplicated GitHub load without removing any required check, keeps main fully tested, keeps every safe-merge caller merging under the local floor, and reverts in one commit.

## Second-pass review

**Reviewer:** independent reviewer subagent (Opus), rounds 1 to 3 on 2026-11-21 (11:35 to 11:51 PST).

**Independent read of the artifact: concur** (round 3). Round 1 raised three concerns: the feedback executor's `--auto` merge path would have refused every merge (fixed in `scripts/safe-merge.mjs`); the comment block above `concurrency:` in ci.yml and the gate note in publish.yml were stale (both rewritten); the per-job comment said "before a release" when no release waits on ci.yml (reworded), and the Node 20/22-before-publish risk was understated (now stated in section 2). Round 2 accepted the safe-merge refactor as behaviour-preserving and found that under the local floor the executor would treat `verify-pending` as a refusal (fixed in `FeedbackExecutorService.ts` with a test). Round 3 confirmed the mapping and the test and noted, outside this change, that `GreenPrAutoMerger` treats only `deferred:checks-pending` as a pass-on; it merges in sync mode under the local floor today, so nothing changes for it here.

## Evidence pointers

- `npx vitest run` over the ci.yml-reading unit test files plus `safe-merge-hardening` and the new `safe-merge-auto-local-floor`: all pass (counts in the pull request).
- `node scripts/safe-merge.mjs --capabilities` still answers (the MergeRunner contract probe).
- `ruby -ryaml` parse of the edited workflow: valid.
- Main ruleset read live on 2026-11-21: required status checks = `instar/local-verify` only.
- GitHub queue read live on 2026-11-21 10:35 PST: 121 queued runs for this repository, 2 in progress; the oldest publish run waited from 08:00 to 10:02 for its first machine.
