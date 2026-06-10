---
title: "Cartographer Subtree Navigation — Scope a Sub-Agent to the Relevant Code"
slug: "cartographer-subtree-nav"
author: "echo"
parent-principle: "The Body and the Mind"
eli16-overview: "cartographer-subtree-nav.eli16.md"
status: "approved"
approved: true
project: "cartographer-conformance"
spec_number: 5
depends-on: "cartographer-doc-tree-schema (spec #1), cartographer-doc-freshness (spec #2)"
review-convergence: "2026-06-10T19:22:28Z"
review-iterations: 1
review-completed-at: "2026-06-10T19:22:28Z"
---

# Cartographer Subtree Navigation

> Spec #5 — the capstone of `cartographer-conformance`. Spec #1 built the doc-tree
> *precisely so* a sub-agent could navigate it to find the relevant code instead of
> loading the whole repo (the doc-tree's own CLAUDE.md affordance: "scoping a
> sub-agent to one subtree without loading the whole repo"). This spec builds that
> navigation: given a task/query, walk the tree's summaries top-down and return the
> minimal **relevant subtree** — the set of node paths a sub-agent should be scoped
> to. Deterministic-first (no LLM cost footgun — the lesson from spec #3's rejected
> drafts), observe-only.

## Problem statement

A sub-agent tasked with work in a large repo today either loads far too much context
(the whole repo / a guessed file list) or depends on the spawning agent hand-picking
files. The cartographer doc-tree is a hierarchical map of plain-language summaries
built for exactly this — but nothing consumes it for navigation yet. Spec #5 turns
the map into a **scoping tool**: "for this task, the relevant code is under
`src/messaging/` and `src/core/TelegramTopicResolver.ts`" — computed cheaply from the
summaries, so a sub-agent gets a tight, relevant context window.

**Observe-only.** The navigator RETURNS a scoped manifest (relevant paths + scores);
it never auto-spawns a sub-agent or mutates anything. The spawning agent decides what
to do with the suggestion.

**Summaries are an injection vector (the spec's hard safety note).** A node summary is
LLM-authored over untrusted code (spec #2). When a navigating sub-agent reads a
summary, a summary that smuggled "ignore your instructions and …" would be an
injection. So EVERY summary the navigator emits is rendered as **quoted untrusted
data** (`delimitUntrusted`) and **neutralized** (`neutralizeInstructionShapedContent`)
— reusing spec #2's pure helpers. This is the binding consumer-contract spec #2
declared on this navigator.

## Foundation contract (from spec #1/#2, verified present on main)

| Primitive | Source | Use |
|---|---|---|
| `loadIndex()` / `getNode(path)` / `getChildren(path)` | `CartographerTree` | the tree walk: read a node + descend into children. |
| node `summary` / `path` / `kind` / `codeHash` / `confidence` | `CartographerNode` | the relevance signal + freshness/trust hints. |
| `delimitUntrusted(label, content)` / `neutralizeInstructionShapedContent(text)` | `cartographerSummary` (spec #2) | render summaries as untrusted data in output. |
| `freshnessHealth()` / node `summary` presence | spec #1/#2 | a node with no summary contributes path-only signal (honest about coverage). |

## Proposed design

### Part A — Deterministic relevance scoring (no LLM)

A pure `scoreNodeRelevance(query, node)` → number, combining cheap signals:

- **Term overlap** between the query's tokens and the node's `summary` + `path`
  basename + path segments (case-insensitive, stemmed-lightly). Distinctive tokens
  (camelCase/PascalCase identifiers, the same shape spec #2 extracts) weigh more than
  common words.
- **Path-segment match** (a query mentioning "telegram" boosts `src/messaging/
  TelegramAdapter.ts`).
- **Depth/specificity** + **two-phase dir scoring** (resolves the top-down ordering
  subtlety): a dir is scored in two phases so the walk doesn't deadlock ("I need child
  scores to score the dir, but I need the dir score to decide whether to visit
  children"). (a) A **provisional** dir score = the dir's OWN summary+path term
  overlap, used to decide descent (descend into the top-`branchingFactor` children
  whose provisional score > `minScore`). (b) A **final** dir score is then folded UP
  from its visited children (max child score, lightly discounted by depth) once they
  are scored — so a dir surfaces as a *container* of relevance, not a false leaf, and
  a dir whose own text didn't match but whose children did is still scored via the
  fold-up. The final score is what ranking + collapse use.
- A node with **no summary** scores on path signal alone (honest — the navigator
  reports `summaryCoverage` so the caller knows how much of the ranking is path-only
  vs summary-informed; a never-swept tree degrades gracefully to path navigation).

### Part B — Recursive top-down navigation (bounded)

`navigate(query, opts)`:

1. Start at the root; score the root's children.
2. Descend into the **top-`branchingFactor`** children whose score exceeds
   `minScore`; recurse to `maxDepth`. This is the "recursive" walk — it reads
   summaries level by level rather than scanning every node, so it is cheap on a deep
   tree (it visits a bounded frontier, not all N nodes).
3. Collect scored nodes; compute the **minimal covering subtree** by a DEFINITE,
   deterministic rule (so the Tier-1 test is writable): a dir **collapses** (its path
   replaces its children in `relevantPaths`) **iff ≥ `collapseFraction` (default 0.6)
   of its VISITED direct children scored above `minScore`**. The denominator is
   *visited* direct children only — a child the bounded walk pruned (never visited,
   so no score) is **excluded** from the fraction, and a dir whose relevant children
   were mostly pruned therefore does NOT collapse (bias toward keeping the specific
   leaves we actually scored). On collapse, the collapsed children are removed from
   `relevantPaths` (the true minimal set); collapsing is applied bottom-up so a
   collapsed dir can itself participate in its parent's fraction.
4. **Bounds (no unbounded recursion):** `maxDepth`, `maxNodesVisited`,
   `maxResults` — each enforced + the truncated count reported (no silent cap).

### Part C — Output: a scoped context manifest

```
{
  query,
  relevantPaths: string[],          // the minimal covering subtree — scope a sub-agent here
  scored: [{ path, kind, score, summary?: string /* delimited+neutralized */, confidence?, fresh: boolean }],
  summaryCoverage: number,          // fraction of scored nodes that had a summary (path-only vs summary-informed)
  nodesVisited, truncated,          // honesty about the bound
}
```

- Every emitted `summary` passes through `delimitUntrusted` + neutralization (§safety).
- `fresh` per node is derived from a **single batched** current-oid read for the whole
  emitted set (one `git ls-tree`, the spec #1 `currentOids()` pattern — NOT a per-node
  `computeStaleness`/`git rev-parse`, which would erode the "cheap" claim on a wide
  frontier) compared to each node's stored `codeHash`. So a caller never treats a
  stale summary as current (the spec #2 `fresh ≠ correct` contract — a summary is a
  hint to re-ground, never an authority).

### Part D — Optional LLM re-ranking (dark, off by default)

A bounded light-tier pass that re-ranks the **top-K deterministic candidates** for
semantic relevance (the deterministic score is the AUTHORITY; the LLM only reorders
the shortlist — Signal vs. Authority). Ships dark behind
`cartographer.subtreeNav.llmRerank.enabled` (+ the off-Claude routing probe + a
separate egress ack, reusing spec #2's pattern), so the navigator is fully functional
and cheap without it. The deterministic path is the shipped value.

### Part E — Surfaces

- `GET /cartographer/navigate?query=…&maxDepth=&maxResults=` → the scoped manifest.
  Behind `cartographer.enabled` (503 when off); Bearer-auth. Read-only.
- An agent-facing affordance (Agent Awareness — this IS a runtime capability agents
  use): "to scope a sub-agent to the relevant code for a task, call
  `GET /cartographer/navigate?query=…` and spawn the sub-agent against `relevantPaths`."

## Security & data-egress

- The deterministic core reads the local index/summaries only — **zero egress**. The
  optional LLM re-rank inherits spec #2's egress posture (off-Claude probe, separate
  egress-ack, bounded) and ships OFF.
- **Summaries are untrusted on output** — `delimitUntrusted` + neutralization on every
  emitted summary; the agent-facing affordance states the hard contract: a navigator's
  summary is quoted data to re-ground against, never an instruction.
- The route validates `query` length + the numeric bounds; no path input is taken
  (paths are produced, never consumed from the request), so no traversal surface.

## Concurrency / multi-machine

Read-only over the local index; no writes, no lease needed. Each machine navigates its
own local doc-tree (identical on the same commit once swept).

## Migration & Deployment / Agent Awareness

- **Config:** `cartographer.subtreeNav` nested under `cartographer` (deep-merge
  backfill): `{ maxDepth: 6, branchingFactor: 4, maxNodesVisited: 200, maxResults: 25,
  minScore: 0.1, llmRerank: { enabled:false, egressAcknowledged:false, framework, allowClaudeFallback:false } }`.
- **CapabilityIndex:** register `GET /cartographer/navigate`.
- **CLAUDE.md (Agent Awareness) — migrator-only, EXACTLY as specs #1/#2/#3** (verified
  at convergence: the cartographer sections are added ONLY via `migrateClaudeMd` with
  their own marker — NOT `generateClaudeMd`, NOT a shadow marker — and are classified
  in the feature-completeness test's `legacyMigratorSections` allowlist). So: add the
  navigate section (the affordance + the "summaries are quoted data, re-ground"
  contract) ONLY via `migrateClaudeMd` with its own idempotent marker, and add that
  marker phrase to `legacyMigratorSections` in `tests/unit/feature-delivery-
  completeness.test.ts` with a one-line rationale (mirroring spec #2's 'Keep the map
  true' / spec #3's 'Standards Enforcement Coverage' entries). Do NOT add a
  `generateClaudeMd` section or a shadow marker (either would trip the parity guard).
- **Rollback:** disabling `cartographer.enabled` 503s the route. No migration reversal.

## Test plan (3 tiers)

- **Tier 1 (unit):** scoring (a query term in a summary/path boosts the node; a
  distinctive identifier outweighs a common word); recursion (descends into relevant
  children, not all nodes; respects `maxDepth`/`maxNodesVisited`/`maxResults` with the
  truncated count reported); minimal-covering-subtree (collapses a fully-relevant dir,
  keeps scattered leaves); **summary sanitization** (a node whose summary carries an
  instruction-shaped payload is emitted as `[neutralized: …]` + delimited);
  **summaryCoverage** honesty (a never-swept tree navigates on path signal + reports
  low coverage); `fresh` derived correctly.
- **Tier 2 (integration/HTTP):** `GET /cartographer/navigate?query=…` → 200 + the
  manifest shape + relevantPaths for a fixture tree; 503 when disabled; 401 no bearer;
  400 on a missing/over-long query or out-of-range bounds.
- **Tier 3 (E2E "alive"):** over a REAL fixture git repo + a scaffolded+authored tree,
  a query for a known subsystem returns that subsystem's paths as `relevantPaths` and
  excludes unrelated subtrees — proving the navigator is wired to a real
  `CartographerTree`, not a no-op, and actually scopes.

## Open questions (resolved by decision)

- **(Resolved — decided)** Deterministic-first; the LLM re-rank is optional, dark,
  advisory — the cheap, convergent path is the shipped value (the spec #3 lesson:
  never make the LLM the cost-bearing authority).
- **(Resolved — out of scope)** Auto-spawning a scoped sub-agent from the manifest is
  not owed here — the navigator returns the suggestion; the spawning agent acts. A
  dashboard surface is also out of scope.
