# ELI16: Worktree Resolver Accepts Agent-Home Source Checkouts

Instar agents are supposed to create development worktrees inside their own agent home. That keeps the work accessible even when the macOS sandbox gets stricter during a long session.

There is a built-in helper for this: the worktree-create command. It is supposed to find the real Instar checkout, create a branch from it, and place the new worktree under the agent's safe home directory.

The bug is that the helper looked in only a few places. It checked an explicit repo override, then a couple of hardcoded folders under the user's home directory. But some developer agents keep their canonical Instar checkout inside the agent home itself, and the command may be running from inside that checkout. In that case the correct repo is right under the command's feet, but the resolver never looks there.

This fix makes the resolver look at the current working directory and the agent home as candidates. If the command is run from a subfolder, it resolves that subfolder back to the git top-level before using it. It still checks that the repo's remote URL is trusted, and it still rejects hook paths that point outside the repo.

There is one more safety detail. Instar has a SourceTreeGuard that normally blocks git mutations against an Instar source tree, because a past test accidentally wiped the real source checkout. That guard is important and stays on by default. The worktree helper, however, has a legitimate reason to run a tiny set of source-tree git operations: it needs to create a worktree, prune stale worktree metadata, and set the new worktree's local git identity. The fix adds a narrow allowance for only those exact shapes. Other source-tree mutations still fail.

The result is that developer agents can use the intended helper again when their Instar checkout lives in the agent home, without weakening the broader safety guard.
