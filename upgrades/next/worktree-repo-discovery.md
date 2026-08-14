# Ask the worktrees which repo owns them

Internal mechanism with **no caller yet**. It ships in `src/`, so it is not internal-only lane material even
though no agent's behaviour changes — that distinction is the gate's, and it is the right one: shipped
runtime code is shipped whether or not anything calls it today.

## What to Tell Your User

Nothing changes for you in this release. This adds an internal ability — working out which repository a set
of working copies belongs to by asking the working copies themselves — and deliberately does not plug it in
anywhere yet.

It exists because the background housekeeper that reclaims finished working copies had been handed a path
that is not a repository, so it failed to look 98 times in a row while 27 GB of finished copies accumulated.
Wiring this in is a separate change that needs review before it goes near anything with permission to delete
directories.

## Summary of New Capabilities

None that you can use. No new command, endpoint, setting, or behaviour. Two internal helper functions and one
opt-in parameter that nothing passes yet.

## What Changed

Adds to `src/core/AgentWorktreeDetector.ts`:

- `parseWorktreeGitPointer(contents)` — `gitdir: /repo/.git/worktrees/<slug>` → `/repo`; null for anything
  that is not exactly that shape.
- `discoverInstarRepoFromWorktrees(roots, {maxWorktrees})` — reads each worktree's `.git` pointer FILE under
  the given roots and returns owning repo roots, ordered by how many worktrees name each. No subprocess:
  reading the pointer is cheaper than `git rev-parse`, cannot block the event loop, and keeps the helper
  usable from the runtime hot dirs.
- `ResolveDetectorRepoOptions.worktreeRoots` — when a caller passes ITS OWN `.worktrees` root(s), discovered
  repos join the candidate chain after the operator-supplied `worktree.repoPath` and before the
  conventional-location guesses. Omitted ⇒ no candidates ⇒ byte-identical behaviour.

**Why.** On a live agent: `GET /worktrees/agent-reaper` reported `enumerationOk: false`,
`enumerationFailures: 98`, `git -C <agent home> worktree list --porcelain → fatal: not a git repository`,
with 45 worktrees and 27 GB unreclaimed. Separately `resolveDetectorInstarRepo` guessed at
`~/Documents/Projects/instar` and `~/instar`; neither exists there, so it returned null and callers guarded
with `if (repo)` skipped silently. Both are the same mistake — a path assumed rather than resolved — while a
linked worktree's `.git` file names its owner outright.

**A misresolution caught during development, now pinned.** The first draft defaulted discovery to
`enumerateSafeRoots()`, which spans EVERY agent home on the machine; measured on the real box, `echo`
resolved to `instar-codey`'s repo. A confident wrong repo is worse than null — null makes a consumer skip, a
wrong repo makes it act. There is now no default: a caller must name its own root.

**Declared limitation.** One agent's `.worktrees/` can legitimately hold worktrees of more than one clone of
the same upstream (measured: 29 owned by `<home>/.build/instar`, 17 by `<home>/.dev/instar`). Both are
returned, most-owned first, unmerged; a consumer taking only `[0]` gets the largest coherent set, not full
coverage. Stated in the function's doc comment.

**Held back deliberately:** pointing `AgentWorktreeReaper` and `OrphanedWorkSentinel` at the resolved repo
instead of `config.projectDir`. That is runtime code feeding a guard with delete authority, and the
misresolution above is evidence that getting it wrong is easy — so it goes through the Tier 2 spec +
operator-approval path as a small focused follow-up, registered as a commitment.

## Evidence

- `tests/unit/agent-worktree-repo-discovery.test.ts` — 14/14 green.
- Existing detector suites unmodified and green (`AgentWorktreeDetector`, `-attention-wireup`,
  `WorktreeEnumerationFailureStore`) — 19/19 — which is what shows the old path is untouched when no caller
  opts in.
- `npm run lint` chain green; `tsc --noEmit` clean.
- Real-machine measurement: with the caller's own root, discovery returns both repos in count order; with no
  root, resolution returns null exactly as before.
- Side-effects: `upgrades/side-effects/worktree-repo-discovery.md` · ELI16:
  `docs/specs/worktree-repo-discovery.eli16.md`.
