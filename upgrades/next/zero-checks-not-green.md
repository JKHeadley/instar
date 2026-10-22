## What Changed

- **A pull request with no GitHub Actions checks no longer counts as green.** When the test workflows never start (PR #2302: a conflict with main stopped `pull_request` from firing, and only Vercel reported), the green-PR watcher used to read the empty result as "settled green", and `safe-merge --auto` would arm GitHub auto-merge. With no required checks on the repository, GitHub then merges at once. Now the watcher skips the PR with the reason `no-checks-ran` (written to its audit log), and `safe-merge` refuses with `refused:no-checks-ran` and a plain message that the PR is NOT green and its CI never started. The local-verify floor is unchanged.

## What to Tell Your User

Nothing changes for you day to day. If your agent merges its own pull requests, it will no longer treat one where the automated tests never started as ready to merge. It waits instead and says why: "no checks ran".

## Evidence

- `tests/integration/safe-merge-no-checks-ran.test.ts` runs the real script with a fake `gh`: `--auto` with only a Vercel check refuses and never calls `gh pr merge`, and with one Actions check it proceeds to arm.
- Unit cases in `green-pr-red-watchdog`, `green-pr-logic` and `safe-merge-hardening` cover an empty rollup, Vercel only, Actions plus Vercel, and a failing/pending status still winning.
- Side-effects review: `upgrades/side-effects/zero-checks-not-green.md`.

## Summary of New Capabilities

- No new capability. The merge path refuses a pull request where no GitHub Actions check ran, and names the reason (`no-checks-ran`).
