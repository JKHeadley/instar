# Side-Effects Review — pull requests skip the heavy CI jobs that Local Verify already runs

**Version / slug:** `ci-pr-skip-duplicate-heavy-jobs`
**Date:** `2026-11-21`
**Author:** `echo (session echo-increasing-throughput)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. One file, `.github/workflows/ci.yml`, 27 lines added, none removed. Each of the five heavy jobs (the unit shard matrix, integration, e2e, the Windows and Mac desktop packaging jobs) gains `if: github.event_name != 'pull_request' && github.event_name != 'pull_request_review'`; `contract` and `build` follow through `needs: unit`. A comment above `concurrency:` records why. Effort: one review round, one commit attempt. No runtime source changed; this is a CI configuration change.

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

- `scripts/safe-merge.mjs` pins the heavy job names in `ACTIONS_FLOOR_CONTEXTS`. Under the configured `floor: local` the merger does not read them. If the floor is switched back to `actions`, `--auto` would defer forever on a pull request because the pinned contexts never appear. The ci.yml comment and this artifact record that pairing.
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

Approved to ship as Tier 1. The change removes duplicated GitHub load without removing any required check, keeps main fully tested, and reverts in one commit.

## Evidence pointers

- `npx vitest run` over the twelve ci.yml-reading unit test files: 12 files, 365 tests, all pass.
- `ruby -ryaml` parse of the edited workflow: valid.
- Main ruleset read live on 2026-11-21: required status checks = `instar/local-verify` only.
- GitHub queue read live on 2026-11-21 10:35 PST: 121 queued runs for this repository, 2 in progress; the oldest publish run waited from 08:00 to 10:02 for its first machine.
