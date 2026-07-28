# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Pre-commit gate: worktree-aware merge detection.** The instar-dev pre-commit
gate intentionally skips merge commits (their content is already-reviewed code
being integrated from another branch). The skip was gated on
`fs.existsSync(path.join(ROOT, '.git', 'MERGE_HEAD'))`, which works in a normal
checkout but silently misses the real MERGE_HEAD in a worktree (where `.git`
is a gitlink-FILE, not a dir — the real file lives at
`.git/worktrees/<name>/MERGE_HEAD`). The gate then falsely fired on every
worktree merge commit.

Fix: resolve the real git dir via `git rev-parse --git-dir` and check there.
Falls back to the literal join on git-lookup failure, so we never falsely SKIP
the gate — only restore the intended SKIP path for worktree merges.

Live evidence: caught during the PR #428 (cross-machine-seamlessness) merge of
main into the seamlessness branch from inside `.worktrees/seamlessness-spec/`.
The merge needed a `--no-verify` to land; this fix retires that need going
forward.

## What to Tell Your User

- A small fix to the safety check that runs before commits: it now correctly
  recognizes when you're in a worktree merge (it used to wrongly demand a
  review trace for those, even though merges by definition are just bringing
  in code that was already reviewed). No change to anything users see — this
  is internal developer tooling.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Worktree-aware pre-commit gate | Automatic — merge commits in any worktree now correctly skip the trace/artifact gate, same as merges in a normal checkout always did. |

## Evidence

**Five-line scripts/ fix; no src/ touched.** `git rev-parse --git-dir` resolves
to the literal `.git` in a normal checkout (preserving prior behavior) and to
`.git/worktrees/<name>` in a worktree (the bug case). Fallback to the literal
join on git-lookup failure preserves the prior fail-CLOSED behavior. Live
regression evidence: the PR #428 merge needed `--no-verify`; with this fix
landed, the equivalent next merge does not. Side-effects review:
`upgrades/side-effects/instar-dev-gate-worktree-merge-detect.md`.
