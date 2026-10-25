# Side-Effects Review — zero GitHub Actions checks is not green

**Version / slug:** `zero-checks-not-green`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The 24h run on the Mama PC found PR #2302 with ZERO GitHub Actions runs (only Vercel reported): `pull_request` never fired while the branch conflicted with main, and still did not after the rebase. Two places in the merge path read that as green:

1. `deriveRollup` (`src/monitoring/greenPrAutomergeWiring.ts`) returned `SUCCESS` whenever no check failed or was pending, so an empty rollup, or a Vercel-only one, was "settled green" to the green-PR watcher.
2. `safe-merge --auto` (`scripts/safe-merge.mjs`) armed GitHub native auto-merge after checking only open / not-draft / head-pinned. With no required checks on the repository, GitHub merges at once.

Fix: `deriveRollup` returns `NO_CHECKS` when no rollup entry carries a non-empty `workflowName` (no GitHub Actions workflow produced a check). `classifyCandidate` skips such a PR with the named reason `no-checks-ran`, and the watcher audits `waiting / no-checks-ran`. `safe-merge --auto` reads the head's check runs and refuses with `refused:no-checks-ran` (with a plain stderr line saying it is NOT green) when none come from the `github-actions` app. The synchronous `--admin`/sync path already refused (e2e missing); it now names the zero-checks case instead of the generic e2e message.

The `local` floor (local-verify) is untouched: it never reads the Actions rollup and never uses `--auto`. `StageTransitionValidator.ciIsGreen` (user projects that may have no CI) is deliberately left alone.

## Decision-point inventory

- `classifyCandidate` (watcher candidacy, actions floor): new skip `no-checks-ran`, only ever more conservative.
- `safe-merge --auto` arming: new refusal before arming.
- `safe-merge` sync path: different refusal *message* for an existing refusal; the decision is unchanged.

## 1. Over-block

A head whose real CI comes only from commit statuses or non-Actions apps would now be refused under the actions floor. instar's CI is GitHub Actions, and the actions floor already requires Actions contexts (`ACTIONS_FLOOR_CONTEXTS`), so such a PR could never pass the sync path either. A `--auto` call made in the seconds after a push, before Actions registers its first check run, is refused; retrying a moment later works, and the watcher only arms settled-green PRs, so it never hits this window.

## 2. Under-block

If some workflows ran but the main CI workflow did not, the watcher still reads SUCCESS from the partial set. The sync path catches that (e2e + producer-bound contexts floor). `--auto` relies on GitHub's required checks for it; on a repo with none, a partial run could still auto-merge. This fix closes only the zero-checks class, which is the incident. A full contexts floor on `--auto` would be a larger change.

## 3. Level-of-abstraction fit

Right layer: `deriveRollup` is the one place the watcher turns raw checks into a verdict, and safe-merge is the act-time authority. Both get the same rule: no Actions check run means not green.

## 4. Signal vs authority compliance

This adds refusal authority, but the check is a deterministic fact (whether any check run from the github-actions app exists on the pinned head), not a brittle judgment. It can only cause "do not merge yet", the safe direction, and it matches the existing `e2e-missing` refusal pattern.

## 4b. Judgment-point check

No competing-signals decision. This is a hard floor ("nothing ran" ≠ "passed"), not a heuristic.

## 5. Interactions

- `MergeRunner` passes `refused:*` results through unchanged. A `refused:no-checks-ran` from `--auto` follows the normal per-PR failure ladder, the same as other refusals.
- The red-PR watchdog uses `failingChecksFromRollup`, which is unchanged.
- Already-armed PRs are skipped before candidacy, so they are unaffected.

## 6. External surfaces

One new result string (`refused:no-checks-ran`), one new audit class (`waiting / no-checks-ran`), and a clearer stderr line. No config and no routes.

## 7. Multi-machine posture

Machine-local by design: the watcher runs only on the lease holder, and safe-merge runs where it is invoked. Both read GitHub, which is shared truth.

## 8. Rollback cost

Revert the commit; no state or migration.

## Conclusion

Simplest fix for the reported class. Ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-10-22
**Independent read of the artifact: concur**

The reviewer checked live gh data. In `statusCheckRollup`, real GitHub Actions entries are CheckRuns with a non-empty `workflowName`; the incident had only the Vercel StatusContext and a Vercel CheckRun with an empty `workflowName`. safe-merge's `appSlug === 'github-actions'` reads the check-runs API `app.slug`, which is the right field. Nothing can newly merge: every change adds a skip or a refusal. `NO_CHECKS` has a single producer (`mapPr`) and a single reader (`classifyCandidate`), and the local floor returns before either is consulted. Soft note, no change needed: a `--auto` call made seconds after a push is refused and counts toward MergeRunner's per-PR ladder. The watcher only arms PRs that are already settled green, so it never hits that window.

## Evidence pointers

- `tests/unit/green-pr-red-watchdog.test.ts`: `deriveRollup` cases for an empty rollup, Vercel-only, Actions plus Vercel, and a failing/pending status.
- `tests/unit/green-pr-logic.test.ts`: `NO_CHECKS` → skip `no-checks-ran`.
- `tests/unit/safe-merge-hardening.test.ts`: `noActionsChecksRan`.
- `tests/integration/safe-merge-no-checks-ran.test.ts`: runs the real script with a fake `gh`; `--auto` refuses and never calls `gh pr merge`, and proceeds when an Actions check exists.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the merge path; the new tests are the regression guard).
