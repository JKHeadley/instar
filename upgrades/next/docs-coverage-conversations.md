# Developer reference pages for the Conversations graph modules

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Documentation only. Two developer architecture pages describe the Conversations graph modules in `src/core/` that shipped without docs: `site/src/content/docs/architecture/conversations-custody.md` (writes, witness, replication, transfer, storage) and `site/src/content/docs/architecture/conversations-recovery-privacy.md` (pending-write recovery, membership, permanent member loss, owner recovery, erasure). Both are written from module header comments and server wiring, including stated limits. No runtime source, configuration, migration, test, scanner or threshold changed.

## Evidence

On a clean worktree at main `59aedce47` (1.3.1735), `node scripts/docs-coverage.mjs --check` failed: overall 54% (780 documented + 970 partial of 2364), class 50% (418 documented / 1207), both below the unchanged 55% floors. With only these two pages added, the same unchanged command passes: overall 57% (827 + 1023 of 2364), class 56% (465 / 1207). `git diff --check` is clean. No tests were run or needed for this docs-only change.
