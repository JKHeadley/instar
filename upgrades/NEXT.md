# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**fix(test-env): close the inherited-GIT_DIR failure class.**

When git invokes a hook (`.husky/pre-push` runs `npm run test:smoke`), it sets `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / `GIT_COMMON_DIR` on the child env. Those variables override cwd-based repo resolution for every descendant git process, so test fixtures that did `git init && git commit` in a tmpdir actually committed into the parent repo on whichever branch was checked out. That's what landed `# Test Project` over the project's `README.md` on `main` via PRs #130 and #277 — the README clobber shipped to npm in the v1.1.x series before PR #285 restored it.

This release closes the failure class in five interlocking layers:

1. **`tests/vitest-setup.ts` strips the GIT_DIR family** from `process.env` before any test file loads. Single-line root-cause fix — no test in the suite can inherit the dangerous overrides from the parent pre-push environment.

2. **`tests/helpers/git-test-env.ts` exports `sanitizedGitEnv()`** for fixtures that pass their own `env` object to `spawnSync` / `execFileSync`. Applied to the three fixtures whose write patterns are visible in PR #130's diff (`worktree-monitor.test.ts`, `SafeGitExecutor.test.ts`, `rich-profile-integration.test.ts`). Defense-in-depth on top of Layer 1.

3. **`scripts/pre-push-fixture-guard.mjs`** runs in `.husky/pre-push` before the smoke tests and refuses pushes whose ahead-of-upstream commits carry the historical fixture signature — author email in `{test@instar.local, t@t.com, t@e.com, test@test.com}` or subject matching `Initial commit` / `seed` / `init` / `Worktree commit N`. Bypass for legitimate test-only branches: `INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1`.

4. **`scripts/check-repo-invariants.mjs`** runs as a dedicated `Repo Invariants` CI job and fails the build if `README.md` drops below 100 lines or if `file-0.txt` / `seed` appear at repo root. Final structural safety net; threshold overridable via `INSTAR_README_MIN_LINES`.

5. **Removed `file-0.txt` and `seed`** stowaway files from repo root — fixture droppings from prior incidents that would have falsely passed Layer 4 on the PR adding it.

Spec: `docs/specs/test-env-isolation.md`. ELI16: `docs/specs/test-env-isolation.eli16.md`. Side-effects review: `upgrades/side-effects/test-env-isolation.md`.

## What to Tell Your User

Nothing user-visible. This release hardens instar's own development pipeline against a class of bug that, while invisible to running agents, had been quietly corrupting our published README. Agents continue to behave identically.

If a contributor asks why their push is suddenly refused with a fixture-pollution guard error, the script's own output includes recovery instructions — usually resetting past a stray commit and pushing again.

## Summary of New Capabilities

This release is a pure hardening fix. No new runtime capabilities for agents. The new pre-push and CI guards are infrastructure for the instar-developing agent and direct contributors only.

## Evidence

The README clobber on `main` was reproduced before the fix landed: `gh api repos/JKHeadley/instar/contents/README.md --jq .size` returned `7` (the literal text `# Test\n`) prior to PR #285. PR #285 restored the README; this PR closes the underlying class so the same regression cannot recur.

Test-fixture pollution detection was verified end-to-end: against a tmpdir repo with a commit subject `Initial commit`, `node scripts/pre-push-fixture-guard.mjs` exits 1 and names the offending commit. Against the same repo with the env bypass set, the script exits 0. Repo-invariant detection was verified end-to-end: against a repo where `README.md` has been trimmed to a single line, `node scripts/check-repo-invariants.mjs` exits 1 and reports the line count; against a healthy repo, it exits 0.

14 new tests across the env-strip regression, the fixture-guard, and the invariants script. The three refactored fixtures (`worktree-monitor.test.ts`, `SafeGitExecutor.test.ts`, `rich-profile-integration.test.ts`) retain their pre-existing 45+ test assertions.
