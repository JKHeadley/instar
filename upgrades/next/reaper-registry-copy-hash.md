# The worktree cleaner recognises the generated standards-registry copy

<!-- bump: patch -->

## What Changed

The worktree reaper's proof that `src/data/standards-registry.md` is an unmodified generated copy used `git hash-object`, which the source-tree guard refuses inside every agent worktree. The proof always failed, so every worktree holding that copy was kept as "uncommitted changes". The copy's git blob id is now computed directly and compared with the committed id; anything that is not an exact copy is still kept.

## What to Tell Your User

- **Old work folders**: "My clean-up of finished work folders was keeping many folders because of one generated file it was supposed to recognise. That's fixed, so more finished folders can be cleaned up safely once cleanup is turned on."
