---
title: "Cartographer Doc-Tree Schema"
slug: "cartographer-doc-tree-schema"
author: "echo"
parent-principle: "Documentation IS Being"
eli16-overview: "cartographer-doc-tree-schema.eli16.md"
status: "approved"
approved: true
approved-by: "justin (topic 22726, model-B autonomous authorization 2026-06-08)"
review-convergence: "2026-06-09T02:15:29Z"
review-iterations: 2
review-completed-at: "2026-06-09T02:15:29Z"
review-report: "docs/specs/reports/cartographer-doc-tree-schema-convergence.md"
project: "cartographer-conformance"
spec_number: 1
principal-separability-approval: "Specs #2 (sweep), #3 (conformance), #5 (nav) are legitimately separable: spec #1 is testable end-to-end on its own (scaffold→setSummary→read→mutate→stale). The project /projects registry tracks #2–#5 as the remaining rounds — this is a planned multi-round project, not dropped work."
---

# Cartographer Doc-Tree Schema

> Spec #1 of the `cartographer-conformance` project — the **substrate** the other
> four specs build on. **v2** — after convergence round 1 (4 internal reviewers:
> adversarial+security, scalability, integration, lessons-aware). Round 1's
> decisive findings, all folded below: (1) staleness MUST be a single batched
> `git ls-tree` walk, never one `git` spawn per node (the make-or-break perf
> issue); (2) the path→file-slug encoding must be collision-free and the
> `?path=` query must be validated (traversal); (3) Migration Parity +
> Agent-Awareness sections were missing; (4) the Tier-3 "alive" test needs a
> concrete author→mutate→stale lifecycle; (5) concurrency/atomicity for the
> index + per-node files. Defines schema, storage, staleness derivation, and the
> read/update interface. Defers bulk authoring (#2), conformance (#3), and
> navigation UX (#5).

## Problem statement

Instar has a **flat structural** map (`ProjectMapper` → `.instar/project-map.json`):
top-level directories, key files, project type — a depth-4 snapshot regenerated
wholesale, with short heuristic descriptions. It answers "what files exist," not
"what does each part of the code *do*," and it has no notion of a node going
stale relative to the code it describes.

The cartographer needs a different structure: a **hierarchical, semantic
doc-tree** where each node describes the code beneath it in plain language, every
node is timestamped and carries a content fingerprint so its **staleness vs. the
code's actual last change is derivable cheaply**, and the tree is **navigable
root→leaf by a recursive sub-agent** so a task can be scoped without loading the
whole codebase into one context. Without this substrate, there is nothing for the
freshness sweep (#2) to keep fresh, nothing for the conformance audit (#3) to read,
and nothing for sub-agents to descend (#5).

This is the North Star machine's "map" half — named but unbuilt. `ProjectMapper`
is the structural skeleton it reuses; `docs-coverage` is a %-measure, not a map.

## Proposed design

### The node model

The tree is a set of **nodes**, one per code unit — a directory (internal node,
with children) or a significant file (leaf). Each node:

```
interface CartographerNode {
  path: string;            // repo-relative POSIX path this node covers ("" = root)
  kind: 'dir' | 'file';
  summary: string;         // plain-language description of what the code here does.
                           //   THE load-bearing content. "" until first authored.
  summaryUpdatedAt: string | null;  // ISO ts the summary was last authored; null = never
  codeHash: string | null; // the git object id of the covered code AT authoring time:
                           //   dir → the git TREE oid for <path>; file → the git BLOB oid.
                           //   Both come from ONE `git ls-tree` walk (see Staleness). null = never.
  codeRev: string | null;  // short HEAD sha when the summary was authored (provenance only)
  children: string[];      // child node paths (dirs only; sorted, repo-relative)
  builtinKind: 'cartographer-node';  // provenance marker (this file is ours, not a user file)
  provenance?: { framework?: string; modelTier?: 'light' | 'standard' };  // who authored (spec #2)
  dirtyAtAuthor?: boolean; // true if codeHash was a working-tree hash, not a committed oid
  // staleness is DERIVED on read, never stored.
}
```

**Staleness is derived, not stored — via ONE batched git call.** This is the
load-bearing perf decision (round-1 scalability finding). A node is `stale` when
the *current* git oid of the code it covers differs from its stored `codeHash`
(`never-authored` if `codeHash`/`summaryUpdatedAt` is null). The whole-tree
staleness scan is **pure git/filesystem, zero LLM, and at most a couple of
processes** — NOT one `git` spawn per node:

```
staleNodes():
  index = loadIndex()                                  // in-memory, ~tens of KB
  # ONE git invocation returns every tracked path's object id in the repo:
  current = parse(`git ls-tree -r -t -z HEAD`)         // {path -> {oid, type}} for trees AND blobs
                                                        //   (-t includes tree/dir entries; -r recurses)
  out = []
  for node in index.nodes:                             // in-memory comparison, O(nodes)
    cur = current[node.path]?.oid
    if node.codeHash == null:      out.push({node.path, 'never-authored'})
    elif cur == null:              out.push({node.path, 'path-gone'})   // covered path deleted
    elif cur != node.codeHash:     out.push({node.path, 'stale'})
  return out
```

`git ls-tree -r -t HEAD` enumerates every tree (dir) and blob (file) oid in the
committed tree in **one process**; staleness is then a hash-map comparison. There
is **no `git rev-parse HEAD:<path>` per node.** (Best case and worst case are both
one git call + an O(nodes) loop.) A dir's tree-oid changes iff anything in its
subtree changed, so the same data supports cheap "is anything under X stale"
queries without extra git calls. `scaffold()` reuses the same single `ls-tree`
output to set each node's `codeHash` at author time.

**Dirty working tree (precise fallback).** When `staleNodes()` is asked to account
for uncommitted edits (opt-in flag; the default compares committed state for
determinism across machines): run `git status --porcelain` once; for any node
whose `<path>` has uncommitted changes, recompute its fingerprint as a SHA-256
over the sorted list of `git ls-files <path>` entries each hashed by `git hash-object`
content — deterministic, ignores untracked noise, never uses mtime (mtime is
unstable across clones — documented Instar lesson). Such nodes are flagged
`dirtyAtAuthor`/`dirty` so consumers know it is a working-tree estimate, not a
committed truth.

A node's derived status ∈ `{ fresh, stale, never-authored, path-gone, dirty }`.

### Tree shape, coverage & safety bounds

The hierarchy mirrors the repo directory tree from the root, deeper than
`ProjectMapper`'s depth-4 cap. Bounds (round-1 adversarial findings — these are
safety limits, not design limits), all config-overridable under `cartographer`:

- **`maxDepth`** (default 12) — hard cap on descent depth.
- **Symlink-loop guard** — `scaffold()` tracks visited real paths (`fs.realpath`);
  a symlink whose target was already visited is not descended.
- **Submodules** — detected via `.gitmodules`; a submodule dir is a single leaf
  node whose `codeHash` is the recorded submodule *pointer* commit (not its
  internal content), so a submodule-pointer bump shows as `stale` exactly once.
- **Skip set** — `node_modules`, `.git`, `.instar`, `.claude`, `dist`, `build`,
  coverage/cache output. Skipping `.instar`/`.claude` is mandatory so the map
  never maps itself.
- **Leaf selection** (default) — source modules (`.ts`/`.js`/`.mjs`/`.cjs`),
  excluding `*.test.*`/`*.spec.*` and generated files; directories always get a
  node. Tunable via `cartographer.leafGlobs` / `cartographer.excludeGlobs`.

`scaffold()` (re)builds the structural skeleton (paths + kinds + children) from a
directory walk and seeds `codeHash` from the single `ls-tree`; `summary` is filled
lazily (by #2). A freshly-scaffolded tree is all-structure / all `never-authored`
and is still valid and testable.

The skip set is **shared, not duplicated**: `ProjectMapper`'s `DEFAULT_SKIP_DIRS`
is extracted to an exported `src/core/skipDirs.ts` consumed by both
(round-1 integration finding) — no coupling to a `ProjectMapper` instance, no
copy that can drift.

### Storage (file-based, atomic)

- `.instar/cartographer/index.json` — `{ schemaVersion, root, generatedAt,
  nodes: { <path> → { kind, summaryUpdatedAt, codeHash, hasChildren } } }`. The
  whole-tree staleness scan reads only this.
- `.instar/cartographer/nodes/<slug>.json` — one file per node (full node incl.
  `summary`). **Slug is collision-free** (round-1 security finding): `<slug> =
  sha256(path).slice(0,40)` — opaque and collision-free; the index (`path → node`)
  is the authoritative reverse lookup, so slug reversibility is not required (each
  node file also stores its own `path`, so the dir is self-describing for debugging).
  NOT a `/`→`__` substitution (which collides `a/b` with a file literally named
  `a__b` and invites `..` traversal). The slug is derived only from
  scaffold-discovered, in-repo paths — never from request input.
- **Atomicity:** every write is write-to-`*.tmp` + `fs.renameSync` (atomic on
  POSIX). Writer discipline: write the per-node file first, then patch the index
  entry, so a reader never sees an index pointing at a half-written node. Single
  writer per process (the #2 sweep / a CLI), many concurrent readers; readers may
  see a node one-write-stale but never torn. **Non-transactional acknowledgement**
  (round-1 external/Gemini note): `setSummary` updates two files; a crash between
  the node write and the index patch leaves the index one version behind that node
  — a benign lag, never corruption, self-healed by the next `setSummary`/`scaffold`.
  The index may be loaded once and cached for the process lifetime; **`staleNodes()`
  always re-reads the current git oids**, so freshness is never served from cache.
- `.instar/cartographer/` is added to `.gitignore` (runtime state, never
  committed) and is inside the skip set (never self-mapped).

### Read / update interface

`CartographerTree` core (`src/core/CartographerTree.ts`) + an HTTP **read** surface
(writes never get an open route — mutation is in-process only):

Core: `scaffold()`, `getNode(path)`, `getChildren(path)`,
`setSummary(path, summary, { codeHash, codeRev, provenance })`,
`computeStaleness(path?)`, `staleNodes()` (the batched scan above).

HTTP (Bearer-auth like all instar routes; **503 when `cartographer.enabled` is
false**, matching the `semanticMemory`/`projectDriftChecker` convention — not 501):
- `GET /cartographer/tree?format=compact|full`
- `GET /cartographer/node?path=<p>` — **validates** `p`: repo-relative, no leading
  `/`, no `..` segment, must be a known node in the index; else `400`. The
  validated path indexes the in-memory map — it is never interpolated into a git
  CLI string (git access is `execFile`-arg form via `SafeGitExecutor`).
- `GET /cartographer/stale` — `{ count, nodes: [{path, status, reason}] }`
- `GET /cartographer/health` — `{ enabled, nodeCount, authoredCount, staleCount,
  neverAuthoredCount, generatedAt }` (the Tier-3 "alive" surface).

**Trust boundary (round-1 security finding):** node `summary` text is
LLM-authored (by #2) and **semantically unverified** at this layer; it is served
as JSON (consumers escape before any HTML render) and downstream specs (#3
conformance, #5 navigation) MUST treat a summary as a hint and re-ground against
the actual code before acting on it. Spec #1 stores and serves; it never asserts a
summary is true.

### Migration & Deployment (Migration Parity)

- **Config default** — `cartographer: { enabled: false, maxDepth: 12, leafGlobs,
  excludeGlobs }` added to `ConfigDefaults`; `PostUpdateMigrator.migrateConfig()`
  (existence-checked) patches existing agents so they gain the (dark) default on
  update. Ships dark; the dev-agent flip can enable it.
- **Boot gate** — AgentServer reads `config.cartographer?.enabled ?? false` and
  wires a real `CartographerTree` or leaves the route context null (→ 503).
- **CLAUDE.md template** — see Agent Awareness; added via `migrateClaudeMd()`
  with a content-sniff guard so existing agents learn the routes on update.
- No new hooks, no new skills, no destructive ops.

### Agent Awareness (CLAUDE.md template — ships in the same PR)

`generateClaudeMd()` (`src/scaffold/templates.ts`) gains a Cartographer block;
`migrateClaudeMd()` adds it to existing agents (idempotent). Draft:

> **Cartographer Doc-Tree** — a hierarchical, semantic map of the codebase with
> per-node freshness. Each node summarizes what a dir/file does; staleness is
> derived from git, free.
> - Tree (compact = index): `curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/cartographer/tree?format=compact`
> - One node: `curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/cartographer/node?path=src/core"`
> - What's stale: `GET /cartographer/stale` · Health: `GET /cartographer/health`
> - **When to use:** orienting in unfamiliar/deep code, or scoping a sub-agent to
>   one subtree without loading the whole repo. Summaries are hints — re-ground
>   against the code before acting.

### What spec #1 includes vs. defers

INCLUDES: node schema, collision-free storage, `scaffold()`, read/update methods,
the batched-git staleness derivation, the HTTP read routes + validation, config
gate + migration + agent-awareness, and a minimal `setSummary` path so the schema
is testable end-to-end. Splits out into later rounds <!-- tracked: cartographer-conformance -->
(legitimately separable; see `principal-separability-approval`): bulk/scheduled
summary authoring + the efficiency contract (spec #2); conformance use (#3);
recursive-navigation UX beyond `getChildren` (#5). Staleness here is **passive** — derived on read; active
cadenced monitoring + escalation is #2's concern, so no `stalenessCheckedAt` field
is stored.

## Decision points touched

1. **Storage granularity** — hybrid (index + per-node files). Resolved: required
   by lazy reads + incremental single-node refresh; a single tree file forces a
   full rewrite per node (bad for the sweep) and a full load per read (bad for nav).
2. **Staleness fingerprint** — git object ids from one `ls-tree`, committed-state
   default, deterministic working-tree fallback. Resolved (mtime rejected).
3. **Coverage depth & leaf selection** — defaults above + config knobs. Resolved.
4. **Relationship to `ProjectMapper`** — reuse the extracted skip-set util; keep
   ProjectMapper the flat snapshot, cartographer the semantic/deep/fresh layer; no
   route/state collision (`/project-map` + `.instar/project-map.json` vs
   `/cartographer/*` + `.instar/cartographer/`). Resolved.
5. **Concurrency** — single-writer + atomic rename + node-before-index ordering;
   readers eventually-consistent, never torn. Resolved.

## Test plan (3 tiers — real surfaces)

- **Tier 1 (unit):** `scaffold()` builds the expected hierarchy over a fixture
  repo (incl. a symlink loop → bounded, a submodule → pointer node, maxDepth
  honored); collision-free slug (paths `a/b` vs `a__b` get distinct files);
  `setSummary` round-trips; `computeStaleness` → `fresh` right after authoring,
  `stale` after the covered file changes, `never-authored` before authoring,
  `path-gone` after deletion; the batched scan issues ONE `git ls-tree`
  (assert via a spy/exec-count) and visits all nodes in-memory; committed vs
  dirty-tree fallback both covered; atomic write leaves no `.tmp` residue.
- **Tier 2 (integration / HTTP):** `/cartographer/*` return 200 with correct
  shapes against a real server; `/stale` reflects a mutated fixture file;
  `/node?path=../../etc/passwd` and `?path=nope` → 400; disabled → 503.
- **Tier 3 (E2E "alive"):** production init path mounts the routes →
  `GET /cartographer/health` → 200 with `nodeCount ≥ 1`; then the lifecycle:
  read a node → `setSummary` → `/stale` count 0 → mutate the covered file →
  `/stale` count 1 (`status: stale`). Proves wiring + git-hash derivation, not a
  no-op.
- **Wiring-integrity:** the route context holds a real `CartographerTree` (not
  null/no-op); `staleNodes()` delegates to real git via `SafeGitExecutor`.

## Open questions

- Default-on vs. ships-dark: lean **ships dark** behind `cartographer.enabled`
  (routes 503 when off), enabled on dev agents — matches Instar's rollout
  convention. (No remaining design blockers; #2–#5 sequencing tracked in
  `/projects` under `cartographer-conformance`.)
