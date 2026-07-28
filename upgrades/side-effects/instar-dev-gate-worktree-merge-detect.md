# Side-Effects Review — instar-dev-precommit: worktree-aware MERGE_HEAD detection

**Scope:** `scripts/instar-dev-precommit.js` lines 41–61.

**Problem.** The pre-commit gate intentionally skips merge commits (their content
is already-reviewed code being integrated from another branch). The skip is
gated on `fs.existsSync(path.join(ROOT, '.git', 'MERGE_HEAD'))`. In a
normal checkout, `.git` is a directory and `MERGE_HEAD` lives directly inside
it — the check works. **In a git worktree, `.git` is a gitlink-FILE** whose
contents are `gitdir: /absolute/path/to/the/real/git/dir`, and the real
`MERGE_HEAD` lives there (e.g.
`.git/worktrees/<worktree-name>/MERGE_HEAD`). The literal `path.join(...)`
silently misses it, so the gate fires on every worktree merge commit and
demands a fresh trace + artifact for a commit that is by definition just an
integration of already-reviewed work.

**Live evidence:** during the PR #428 (cross-machine-seamlessness) merge of
`main` into the branch inside the `.worktrees/seamlessness-spec/` worktree,
the gate fired with the standard "No fresh trace found" message even though
the working tree had `MERGE_HEAD` written by `git merge`. We confirmed with
`git rev-parse --git-dir` that the real git dir was
`/Users/.../.git/worktrees/seamlessness-spec/` and the MERGE_HEAD file
indeed existed THERE, not in the literal `.git/` (which was a gitlink file
in the worktree, not a dir).

**Fix.** Resolve the real git dir via `git rev-parse --git-dir` (the standard
git porcelain primitive for exactly this lookup), then check for
`MERGE_HEAD` inside the resolved dir. Falls back to the previous literal
join on `git` lookup failure — so we never falsely SKIP, only restore the
intended SKIP path.

**Side-effects review.**
- **No behavior change for normal checkouts.** `git rev-parse --git-dir`
  in a normal checkout returns the literal `.git`, which we then join the
  same way the old code did.
- **Worktree merges now correctly SKIP the gate** — this is the intended
  behavior restored, not new latitude. Worktree merges were always meant
  to skip; the bug was that they didn't.
- **No new SKIP path.** Non-merge commits in a worktree still fall through
  to the full gate (trace check, artifact check, etc.).
- **Failure mode is safe.** If `git rev-parse --git-dir` ever fails, we
  fall back to the literal join — the worst case is the OLD behavior
  (gate fires on worktree merges), never a false SKIP that lets a real
  non-merge commit slip past unreviewed.

**Test coverage.**
- No new unit test added: this is a 5-line shell-driven environmental fix
  to a pre-commit hook, exercised whenever any agent runs a merge commit
  in any worktree. The regression test IS this fix landing — the very
  next worktree-merge after this PR's merge no longer needs `--no-verify`.
- A simple regression check (run a `git merge` inside a worktree, observe
  the gate output) would be a useful future addition under
  `tests/integration/precommit-gate.test.ts` but is out of scope for
  this micro-fix.

**Migration parity.** None. `scripts/` files run from the instar source
checkout; they are not installed into agents. The fix takes effect the
next time the instar dev environment runs the pre-commit hook.

**Rollback.** Revert the commit. The literal `path.join(ROOT, '.git', ...)`
behavior returns, and worktree merges will once again falsely fire the
gate. No data corruption, no security implication.
