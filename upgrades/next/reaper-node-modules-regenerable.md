<!-- bump: patch -->
## What Changed

The agent-home worktree reaper can now show that a checkout's real `node_modules` install is rebuildable.

- **Reference build.** A niced background builder makes one reference install per lockfile, offline, running no package code, and keeps only a fingerprint list (at most 30).
- **Comparison.** A checkout's install passes only if every file matches by content. Files that packages build for themselves are archived first, in a store that keeps each distinct file once.
- **Links found first.** Links from other checkouts are found wherever git knows a checkout lives.
- **Last checks.** Every file is checked again just before and just after the move to trash.

Removal stays off.

## What to Tell Your User

Nothing to do. The cleanup report now also counts old working copies that hold their own library install. Actual removal stays off until it is approved.

## Summary of New Capabilities

- Verdict `node-modules-residue` for a provably rebuildable `node_modules`.
- Report fields: manifest count and size, scratch high-water mark, and residue store size.

## Evidence

- Unit tests: 123 across the new and existing reaper files.
- Integration: 2 of 2 with a real npm install and the compiled builder child.
- Convergence: 11 of 11.
