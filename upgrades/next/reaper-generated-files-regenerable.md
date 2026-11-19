<!-- bump: patch -->
## What Changed

The agent-home worktree reaper now recognises the repository's own generated files, so a merged checkout holding only those can be listed as reclaimable.

- **`src/data/standards-registry.md`** counts as rebuildable when it matches the committed `docs/STANDARDS-REGISTRY.md`.
- **Other build and tool outputs are archived byte for byte before any removal and never deleted from the archive.** These are: the standards meta and guard index, the builtin manifest, coverage and cache files, husky's `.husky/_` shims, and the per-checkout audit trails.
- **A final fresh re-check right before removal** keeps the checkout if anything changed.

On the Studio, 151 of 210 worktrees kept as having uncommitted changes were clean by git status, held back only by these files (fb-802a84bf-133). The reaper still runs in dry-run. Its report now projects what would be archived and reclaimed.

## What to Tell Your User

Nothing to do. The cleanup report for the agent's old working copies is now accurate. Actual removal stays off until it is approved with the new numbers.

## Summary of New Capabilities

- The worktree reaper recognises generated and audit files, and preserves them before any removal.
- The reaper report shows the archive's size and dry-run projections.

## Evidence

- Unit: `tests/unit/agent-worktree-reaper-generated-files.test.ts` 27/27; existing reaper suites 101/101 and 11/11.
- Integration: `tests/integration/agent-worktree-reaper-generated-files.test.ts` 3/3 on a real git worktree with a husky 9.1.7 install. It shows eligible with projection; a full remove path that archives every residue byte for byte and writes nothing into the checkout's `.instar/audit/`; and dry-run as the shipped default.
