# Bound worktree creation and preserve ignored files

## Summary of New Capabilities

`instar worktree create` stops at 500 child directories per agent and serializes concurrent creation calls. The reaper now keeps checkouts containing ignored files, including cache folders that may contain unique work.

## What Changed

- An agent-local exclusive lock spans directory counting and Git worktree creation. A crash-left lock fails closed for inspection.
- A symlinked `.worktrees` folder is refused before chmod or lock acquisition.
- The reaper checks ignored files and exempts no untracked or ignored path. Its existing repository selection and enable/dry-run settings are unchanged.

## Evidence

Focused unit tests, TypeScript, build, real-Git integration (10/10), and production-lifecycle E2E (2/2) passed. A full unit run found one closed-allowlist size assertion that still expected 12 read verbs; the test and its approved spec now account for the new read-only `ls-files` verb. The complete rerun passed 52,820 unit, 4,930 integration, and 3,594 E2E tests with zero failures. Echo's six-hour cleaner has three successful launchd runs, and its live physical worktree count was 308 on 2026-10-28.

## What to Tell Your User

New CLI worktrees stop at a bounded physical count. Existing work and unique ignored files are preserved for review or verified archival cleanup.
