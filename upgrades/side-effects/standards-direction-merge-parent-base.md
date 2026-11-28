# Side-Effects Review — the direction guard's protected base is the main commit the run tests

**Version / slug:** `standards-direction-merge-parent-base`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy, at the Chief of Staff's request, 19:15)`
**Second-pass reviewer:** `independent read-only reviewer subagent — CONCUR on re-review`

## Summary of the change

- `.github/workflows/ci.yml`, "Resolve protected-base area ledger" step: a new `EVENT_NAME` env. For a `pull_request` or `pull_request_review` run whose checkout is a merge commit, the base becomes `HEAD^1` (the base-branch tip the merge was built on), but only if the event's `base.sha` is an ancestor of it and it is an ancestor of `origin/main`. The step outputs `base`, and every `git show` uses it. The check step's `STANDARDS_DIRECTION_BASE_REVISION` now reads `steps.area-audit-base.outputs.base`.
- `scripts/standards-coverage.mjs`: the workflow pin (`expectedBaseRun`, the base step's env keys, and the check step's env) is updated to match exactly. The script still refuses any other workflow shape.
- Tests: the existing ratchet fixture is updated, and `tests/unit/standards-direction-base-merge-parent.test.ts` runs the real step from ci.yml in throwaway git repositories. It covers: the stale base moves forward; a parent not on main is refused; a parent that does not descend from the event base is refused; a review run takes the same rule; a push is unchanged; a missing origin/main falls back to the event base; a non-merge checkout is unchanged.

## Decision-point inventory

The guard's protected base, its trust root, for `pull_request` runs. No other decision changes.

## 1. Over-block

This removes an over-block: inherited standards were read as the PR's own (#3387, 2026-11-27).

## 2. Under-block

- Could a PR make its own changes look inherited? Only by getting them onto main first. The base must be an ancestor of `origin/main`, and `HEAD^1` of GitHub's merge ref is the base-branch tip, never a PR commit.
- With no `origin/main` tracking ref, both ancestor tests fail inside the `if`, which does not abort under `bash -e`, so the event base stands, which is the old behaviour. Fork PRs do have `origin/main` (origin is the upstream repository).
- Signed ratifications are tied to the base revision, which now moves whenever main moves. That fails closed: a ratification for an older base no longer matches and must be re-signed.

## 3. Level-of-abstraction fit

The fix is where the base is chosen: the workflow step the script already pins. The measurement step already used the merge base (`canonical-server-content-addressed-merge-base`). This makes the direction guard agree with it.

## 4. Signal vs authority compliance

No new authority. The guard's authority is unchanged, and only its input is corrected.

## 4b. Judgment-point check

None.

## 5. Interactions

- `area-audit-base`'s `required` output and the area-audit base file now also come from the same corrected base, so area audits are judged against the tested main. Previously they used the stale event base.
- The "Migration consumer lockstep" step still diffs against `base.sha`. It is unchanged here and out of scope.

## 6. External surfaces

CI behaviour only, on `pull_request` runs.

## 7. Multi-machine posture

Not applicable: GitHub Actions.

## 8. Rollback cost

Revert the PR. The workflow and the pin revert together.

## Conclusion

A narrow correction to the guard's input, with two safety conditions that keep the trust root on main.

## Second-pass review

**Reviewer:** independent read-only reviewer subagent, launched by the Pipeline Strategy session with no part in writing the change. It worked by reading the code and running the real step from ci.yml under `bash -e` in throwaway repositories.
**Verdict:** DISSENT, then CONCUR on re-review (2026-11-27 19:24).
- The DISSENT found that `pull_request_review` runs check out the same merge ref and kept the stale base, and that the test asserted that. Fixed in the workflow, the pin and the fixture, byte for byte.
- It confirmed there is no bypass: a PR's own registry change sits in HEAD^2 and still counts as its own. Fork PRs have the upstream `origin/main`. `pull_request_target` is not a trigger, and the pin refuses adding it. The ancestor checks inside the `if` fail safe under `bash -e`.
- Out of scope and stated: "Migration consumer lockstep" and `AUDIT_CHANGE_BASE_SHA` still read the event base.
Review record: `.instar/state/handoffs/reviews/direction-guard-merge-parent-review.md` (agent-local).

## Release note fix (2026-11-27, about 20:35 PT)

CI assembles the release notes from main plus this branch. Main's upgrades/next/ was empty after a release, so this fragment was checked alone, and it failed the repository invariant "missing ## Summary of New Capabilities section" (seen on #4038). Fix: internal-only marker added: the change is CI-only and stages nothing under src/, so the assembler fills the two user-facing sections. Checked alone with the repository's own assembleNextMd and validateGuideContent: the old version fails and the new one passes.
