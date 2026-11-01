<!-- internal-only -->
## What Changed

**safe-merge no longer refuses large pull requests with `gh spawn failed: spawnSync gh ENOBUFS`.**

`scripts/safe-merge.mjs` ran every `gh` command through `spawnSync` with Node's default
output ceiling of 1 MiB. The review pre-check and the local-floor check read the PR's
changed files with `pulls/N/files --paginate --slurp`, whose answer carries every file's
patch. PR #2364 (94 files, a 1.6 MB diff) overflowed it, `gh` was killed with ENOBUFS, and
the merge was refused as `refused:contexts-unverifiable`. Any PR of that size could not be
merged at all.

Every `gh` spawn in the script (the shared `gh()` helper, the head-pinned merge, and the
native auto-merge arm) now passes one named option set, `GH_SPAWN_OPTIONS`, with
`maxBuffer: GH_MAX_BUFFER` (256 MiB). Nothing else about how the output is read changes.

**safe-merge no longer refuses code-owned PRs forever after the code owner approves.**

The main ruleset requires a code-owner review with `required_approving_review_count: 0`, so
GitHub leaves `reviewDecision` empty even after the owner approves, and safe-merge answered
`refused:approval-required` for every PR touching a CODEOWNERS path (PR #2389). When the
decision is empty and owned files are touched, safe-merge now reads the PR's reviews and passes
only if each owned file has a user owner whose latest review is APPROVED on the current head
(author and the merging account excluded; team owners refuse with `owner-unresolvable`). A set
decision behaves exactly as before.

## Evidence

- `tests/unit/safe-merge-gh-buffer.test.ts`: a real child process writing 3 MiB overflows the
  default spawn options (ENOBUFS), and returns intact through safe-merge's own `gh()`; a real
  spawn failure still throws; every `spawnSync('gh', …)` in the script uses the shared options.
- `tests/unit/safe-merge-code-owner-reviews.test.ts`: owner approval on head passes; stale-commit,
  non-owner, later changes-requested, dismissed, self-approval, merging-account and team-only cases
  refuse; set reviewDecision paths unchanged; reviewPrecheck wiring pinned.
- The existing safe-merge, merge-runner and green-PR suites pass unchanged (277 tests).
