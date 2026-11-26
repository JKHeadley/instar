---
title: Verified dependencies for new Studio worktrees
---
When the Studio steward has enabled a verified dependency store, keep using `instar worktree create <branch>`. A compatible entry supplies private copy-on-write dependencies before the existing SQLite and Git hook checks. The command reports a verified clone or a private install. A failed integrity check needs stewardship inspection before retrying. The store only applies to the normal CLI checkout flow, and explicit `--no-share-node-modules` keeps its existing behavior.
