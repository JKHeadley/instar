<!-- bump: minor -->

## What Changed

Adds **Cartographer Subtree Navigation** (spec #5, the capstone of the
cartographer-conformance project) — turns the codebase doc-tree from something you look
at into something that **scopes work**. Ships **dark** behind `cartographer.enabled`.

Given a task or query, the navigator walks the doc-tree's summaries top-down — a bounded
frontier, not every node — scores each node by how well it matches the query (with
distinctive code identifiers weighing more than common words), and returns the **minimal
relevant subtree**: the smallest set of paths whose union covers the relevant code, so a
sub-agent can be scoped to those paths instead of the whole repository. It collapses a
directory into a single path when most of its visited children are relevant, and keeps
individual files when relevance is scattered.

The core is fully deterministic — local reads only, zero token cost, nothing leaves the
machine, identical output every run. An optional language-model re-ranking pass for the
close calls exists but ships off; the deterministic score is always the authority. Two
honesty properties: it reports `summaryCoverage` (so a not-yet-summarized tree degrades
gracefully to path-based navigation and says so), and it marks each node `fresh` (a
summary whose code has since changed is flagged, never silently treated as current).

Exposed as one read-only route, `GET /cartographer/navigate?query=…`. Every summary it
returns is rendered as quoted, neutralized data — because a summary was written by a
model reading untrusted code, the navigator declaws any instruction-shaped text before a
downstream sub-agent ever reads it.

## What to Tell Your User

- **Point a helper at just the relevant code**: "I can now ask the codebase map 'what's
  the relevant code for this task?' and get back a short list of folders and files —
  then scope a helper agent to exactly that, instead of having it wade through the whole
  repo. It costs nothing to run and it's off until the map feature is enabled."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Scope a sub-agent to the relevant subtree | GET /cartographer/navigate?query=… (opt-in; off by default) |
| Bounded relevance ranking over the doc-tree | the same route — returns scored nodes + the minimal covering paths |
