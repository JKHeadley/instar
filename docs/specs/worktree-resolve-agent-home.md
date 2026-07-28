---
title: Worktree resolver accepts agent-home source checkouts
review-convergence: retrospective-single-pass
approved: true
eli16-overview: worktree-resolve-agent-home.eli16.md
---

# Worktree Resolver Accepts Agent-Home Source Checkouts

## Problem

`instar worktree create <branch>` can fail for a developer agent whose canonical Instar checkout is the agent home or the current working tree. The resolver only checks an explicit repo override and a couple of hardcoded home-directory paths, so it can miss the valid checkout the command is already running inside.

The failure is confusing because the command reports only the hardcoded candidates. It never says it considered the current checkout, because it did not.

## Scope

This change updates the worktree-create path only:

- Treat the current working directory as an Instar repo candidate.
- Treat `INSTAR_AGENT_HOME` as an Instar repo candidate when it is set.
- Resolve subdirectory candidates to their git top-level before returning them.
- Keep remote URL allowlist validation.
- Keep `core.hooksPath` containment validation.
- Keep SourceTreeGuard as the default for source-tree git operations.
- Add one narrow SafeGitExecutor allowance for the exact source-tree operations `InstarWorktreeManager` needs to create a worktree.

## Non-Goals

- Do not allow arbitrary source-tree mutation.
- Do not remove the repo URL allowlist.
- Do not change where agent worktrees are created.
- Do not change raw `git worktree add` behavior outside the Instar manager.

## Acceptance Criteria

- `resolveInstarRepo` can discover a valid repo from cwd.
- `resolveInstarRepo` can discover a valid repo from `INSTAR_AGENT_HOME` when cwd is elsewhere.
- Invalid repo candidates still fail when no later legitimate candidate exists.
- SourceTreeGuard still blocks unrelated source-tree mutations.
- `createWorktree` succeeds against a source-tree-shaped Instar fixture.
- The live CLI path succeeds from a developer worktree and creates the target under the agent home.
