<!-- bump: minor -->

## What Changed

Introduces the **Cartographer doc-tree** — the substrate of the cartographer-conformance project. A new `CartographerTree` core module builds a hierarchical semantic map of the codebase: one node per directory and source file, each carrying a plain-English summary and a git-object-id fingerprint. Staleness is derived from a single batched `git ls-tree` (not a per-node git spawn), so the tree can report exactly which summaries have drifted from the code they describe — at near-zero cost.

Four read-only routes are added, all behind a dark-by-default `cartographer.enabled` gate (the feature is inert — routes 503 — until explicitly turned on): GET /cartographer/tree, /cartographer/node, /cartographer/stale, and /cartographer/health. Node-store filenames are collision-free sha256 slugs; the path lookup validates against traversal. The shared directory skip-set was extracted from ProjectMapper into a single skipDirs module that both now import. Destructive filesystem pruning of stale node files is funneled through SafeFsExecutor.

This is spec #1 of a multi-round project; later rounds add summary authoring, a freshness sweep, and conformance auditing. It changes no existing behavior — a fresh agent gets the feature off.

## What to Tell Your User

- **A living map of your codebase (groundwork)**: "I'm building a self-maintaining map of this project — a tree of plain-English summaries, one per folder and file, that can tell when a summary has fallen behind the code it describes. This first piece is the foundation, and it's turned off by default for now. I'll let you know when the rest is ready to switch on."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codebase doc-tree map | GET /cartographer/tree (opt-in; off by default) |
| Per-node summary lookup | GET /cartographer/node?path=… |
| Stale-summary detection | GET /cartographer/stale |
| Feature health / liveness | GET /cartographer/health |
