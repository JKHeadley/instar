# Side-Effects Review — topic worktrees on an instar source checkout

**Version / slug:** `topic-worktree-source-tree`
**Date:** `2026-10-27`
**Author:** `Echo`
**Tier:** 1 (narrow bug fix, one file + one test; a revert fully undoes it). Effort: no spec rounds, one build pass.

## Summary of the change

`POST /sessions/spawn` with a `topicId` from an agent whose project directory is an instar git checkout (the instar-dev agent's home) failed: `WorktreeManager.createBinding` ran `git -C <project> branch <topic-branch>`, and SourceTreeGuard refuses destructive git against the instar source tree. When the project is outside `~/.instar` the clone path ran instead and was refused too (`clone-default`). So no topic-bound session could start there, and replies were not routed back to the topic.

Fix: when `isInstarSourceTree(projectDir)` is true, `createBinding` calls a new `addInstarSourceWorktree`, which runs ONE `git -C <project> worktree add [-b <branch>] <path> [origin/main|HEAD]` with `sourceTreeWorktreeManagerOk: true`. That flag's allowlist (`isSourceTreeWorktreeManagerInvocation`) already admits `worktree add` and `rev-parse` for `InstarWorktreeManager` and the worktree reaper; nothing is added to it. Two existing reads on the same path (adopting an existing worktree dir via `rev-parse HEAD`, and `config --get core.hooksPath` in `seedGitHooks`) get the same flag; both are inside the allowlist and read-only.

## Decision-point inventory

- No new decision authority. The guard's allowlist and detection are unchanged. The only new branch is "project is an instar source tree → use the single `worktree add` form".

## 1. Over-block

None added. Previously every spawn on such an agent was blocked; now it succeeds.

## 2. Under-block

`release`/`forceTake` still unlink `.session.lock` through SafeFsExecutor, which the guard refuses inside an instar-copy worktree; those calls were already wrapped `@silent-fallback-ok`. A leftover lock file is harmless: liveness comes from heartbeat age and the next `writeLockAtomic` replaces it. Not changed here.

## 3. Level-of-abstraction fit

Right layer: the guard stays the authority; the caller uses the git shape the guard already permits for this exact purpose, instead of widening the guard.

## 4. Signal vs authority compliance

No authority is added or weakened. `sourceTreeWorktreeManagerOk` admits only the enumerated read verbs and `worktree add/prune/list/remove(non-force)`; `git branch` against the source stays refused (asserted by the new test).

## 5. Interactions

- `isInstarSourceTree` fails closed (returns true) when it cannot decide; then the `worktree add` form is used, which is still a non-destructive add.
- For an instar checkout outside `~/.instar`, this path is now taken instead of the clone path (which the guard refused anyway). That reintroduces the per-worktree metadata under the source `.git/` that clone-default avoids; acceptable versus total failure, and agents are already steered out of TCC-protected folders.
- Base branch: `origin/main` instead of the checkout's HEAD for NEW topic branches on an instar checkout (the home may be on any local branch). Non-instar projects keep HEAD.

## 6. External surfaces

No routes, config or messages change. Only agents whose project is an instar checkout see a difference: spawns that failed now work.

## 7. Multi-machine posture

Machine-local by design: worktrees and bindings live on the machine that runs the session, as before.

## 8. Rollback cost

Revert the commit; agents return to the failing behavior. No state or data migration.

## Second pass

Not required: no change to gate/guard logic, block/allow decisions, or session lifecycle authority; only the git invocation shape used during worktree creation.
