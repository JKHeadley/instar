# Side-Effects Review — SourceTreeGuard read-tier + worktree-remove for the AgentWorktreeReaper

**Version / slug:** `source-tree-guard-reaper-readtier`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required (single-author safety-guard fix; review is exhaustive below)`

## Summary of the change

The AgentWorktreeReaper (v1.3.133) runs inside the instar server, whose working
directory IS a checkout of the instar source tree. Every git call it makes was
blocked by the SourceTreeGuard, so it reported 0 reclaimable in production. This
change makes three precise, shape-checked widenings in `src/core/SafeGitExecutor.ts`
— add `cherry` to `READONLY_GIT_VERBS`; add `status` + `cherry` to
`SOURCE_TREE_READ_TIER_VERBS`; extend the worktree-manager source-tree allowlist
(`isAllowedWorktreeManagerSubcommand`) to permit `worktree list` and non-forced
`worktree remove` alongside `add`/`prune` — and passes the corresponding bypass
flags from the reaper's git wrapper (`src/monitoring/agentWorktreeGit.ts`). It
interacts with one decision point: the SourceTreeGuard source-tree bypass.

## Decision-point inventory

- `SafeGitExecutor.isSourceTreeCheckBypassed` (via `SOURCE_TREE_READ_TIER_VERBS`) — modify — add two pure-read verbs (`status`, `cherry`) to the read-tier allowlist.
- `SafeGitExecutor.isAllowedWorktreeManagerSubcommand` (renamed from `isWorktreeManagerMutation`) — modify — add `list` + non-forced `remove` to the worktree-manager allowlist; explicitly deny `--force`/`-f`.
- `SafeGitExecutor.readSync` verb classification (via `READONLY_GIT_VERBS`) — modify — recognize `cherry` as read-only (root cause of the silent failure).
- `agentWorktreeGit.ts` `defaultReadGit` / `removeWorktree` — modify — pass the bypass flags.

---

## 1. Over-block

After the change the guard is slightly *more* permissive, not less, so over-block
risk is unchanged for everyone except the reaper. The one thing that could be
called "over-block" is intentional: `worktree remove --force` against the source
tree is still rejected even with `sourceTreeWorktreeManagerOk`. That is by design —
the forced form is the only one that can delete a dirty worktree, and the reaper
never needs it. No legitimate caller is newly rejected.

---

## 2. Under-block

The relevant question for a guard-*widening* is "does this newly ALLOW something
dangerous?" The widenings are: two pure reads (`status`, `cherry` — cannot mutate)
and `worktree remove` without `--force` (which git itself refuses to run against a
dirty/locked worktree). The residual under-block surface: a caller holding
`sourceTreeWorktreeManagerOk` could now run `worktree remove` (non-forced) against
the source tree. That flag is opt-in per call and currently set only by
`instar worktree create` and this reaper; the non-forced form is self-protecting
(refuses dirty/locked), so even a misuse cannot delete uncommitted work. `--force`
stays blocked, which closes the only data-loss path.

---

## 3. Level-of-abstraction fit

Correct layer. These are pure reads plus one narrowly-shaped, self-protecting
mutation, expressed as additions to existing closed allowlists (the established
pattern for `fetch`/`rev-parse`/`add`/`prune`). The reaper continues to USE the
`SafeGitExecutor` primitive rather than re-implementing git access, and the
merged/clean/in-use reasoning stays in the reaper classifier — this change only
unblocks the reads/remove it already wanted to make.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over messages or user-facing
  actions. It widens an internal git safety allowlist for one internal consumer.

The SourceTreeGuard does hold blocking authority, but its logic here is a closed,
shape-checked allowlist (not brittle heuristic), and the change makes it recognize
two harmless reads and one self-protecting mutation. No new blocking authority is
introduced; the reaper itself remains signal-only (dark + dry-run by default).

---

## 5. Interactions

- **Shadowing:** none. The bypass check runs in the same place it always has
  (`isSourceTreeCheckBypassed` inside `readSync`/`execSync`); we add entries to its
  allowlists, we don't reorder checks. `readSync` still rejects destructive shapes
  before the source-tree check, so the read-path widening cannot enable a mutation.
- **Double-fire:** none. The reaper is the only new consumer; the immediate manual
  reclaim used direct shell `git` (not via SafeGitExecutor) and is unaffected.
- **Races:** the reaper's `worktree remove` and a concurrent session inside the same
  worktree — covered by the reaper's existing not-in-use gate (lock file + live
  process cwd) AND by git's own non-forced refusal if the worktree is locked. Two
  layers.
- **Feedback loops:** none.

---

## 6. External surfaces

- **Other agents on the same machine:** the guard widening is per-call opt-in via
  flags only this reaper and `instar worktree create` set, so other code paths are
  unchanged. The reaper ships dark + dry-run, so no agent's worktrees are touched
  until explicitly enabled.
- **Install base:** pure source change, no config/migration/agent-installed files —
  every agent picks it up on the normal update; behavior is identical until the
  reaper is enabled.
- **External systems:** none.
- **Persistent state:** none added. When enabled, the reaper removes worktree
  *checkouts* (disk) but never branches/commits — the work is preserved in the
  branch ref and in main.
- **Timing:** none we don't control.

---

## 7. Rollback cost

- **Hot-fix release:** revert the one commit, ship as the next patch. The reaper
  reverts to reporting 0 (blocked); no functional regression elsewhere.
- **Data migration:** none — no persistent state introduced.
- **Agent state repair:** none — no agent needs notification or reset.
- **User visibility:** none — the reaper is dark by default, so no user sees a
  change during a rollback window.

---

## Conclusion

This review confirmed the change is a tightly-scoped guard widening: two pure reads
and one self-protecting mutation, with the only data-loss path (`worktree remove
--force`) explicitly kept blocked. The review reinforced the decision to deny
`--force` in the allowlist (not just rely on the reaper never passing it) and to
add a real-git integration test against a promoted source tree — the test the
original fake-git suite lacked, which is why the reaper shipped non-functional.
Clear to ship; verify live via `GET /worktrees/agent-reaper` reporting non-zero.
