<!-- bump: patch -->

# `instar worktree create` accepts real agent homes again (guard-safe remote check)

## What to Tell Your User

Nothing user-visible — contributor/agent infrastructure. Agents can create build worktrees through the safe CLI path again instead of falling back to raw git.

## Summary of New Capabilities

- The worktree CLI's repo-trust check now reads remotes in a form the source-tree safety guard permits, so an agent's own checkout (fetch-from-fork, push-to-canonical) validates correctly — including via `remote.<name>.pushurl`.
- Because the CLI path works, every created worktree gets identity + husky-hook wiring again (`ensureHuskyHooksActive` was already in the code but unreachable in practice).

## What Changed

`validateInstarRepoCandidate` enumerates remotes with read-only `git config --get-regexp '^remote\..*\.(url|pushurl)$'` instead of `git remote -v`. The `remote` verb is not in SafeGitExecutor's source-tree allowance, so on agent homes the old call threw inside `tryGit`, was swallowed, and the #777 any-remote check silently no-oped.

## Evidence

Reproduced live (2026-06-05): `resolveInstarRepo({cwd: '/Users/justin/.instar/agents/echo'})` on current main threw `remote.origin.url …instar-echo.git not in worktree.repoUrlAllowlist` even though origin's pushurl `git@github.com:instar-ai/instar.git` is in the DEFAULT allowlist; isolated the cause to SourceTreeGuardError thrown by `SafeGitExecutor.readSync(['remote','-v'])` against the source tree (config reads pass, `remote` does not). After the fix the same call resolves: `{"repoPath":"/Users/justin/.instar/agents/echo","remoteUrl":"git@github.com:instar-ai/instar.git"}`. Downstream impact verified the hard way: this session's three raw-git worktrees all lacked `.husky/_` and ran ZERO pre-commit hooks. Pinned by three new tests using `sourceSignature: true` fixtures (which trip the guard exactly like a real agent home): second-remote acceptance, pushurl acceptance, and nothing-allowlisted rejection. 34/34 file suite green.
