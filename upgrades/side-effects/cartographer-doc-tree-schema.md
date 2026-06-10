# Side-Effects Review — Cartographer Doc-Tree Schema (spec #1)

**Version / slug:** `cartographer-doc-tree-schema`
**Date:** `2026-06-09`
**Author:** `echo`
**Second-pass reviewer:** `external Gemini cross-model (convergence round 2) — no material findings`

## Summary of the change

Adds the substrate of the `cartographer-conformance` project: a new
`CartographerTree` core module (hierarchical semantic doc-tree of the codebase,
per-node git-object-id staleness derived from ONE batched `git ls-tree`), a shared
`skipDirs.ts` (extracted from `ProjectMapper`, which now imports it), four
read-only HTTP routes `GET /cartographer/{tree,node,stale,health}` gated behind a
dark-by-default `cartographer.enabled` config, the config default + CLAUDE.md
template/migration (Migration Parity + Agent Awareness), and 3-tier tests.

## Decision-point inventory

One gate: the routes return **503** when `cartographer.enabled` is false (or the
context holds no tree). No block/allow logic beyond the enable gate and the
`/cartographer/node?path=` validation (reject leading `/` or a `..` segment → 400).

## 1. Over-block
The `?path=` validation rejects only traversal-shaped inputs (`/`-prefixed or
containing a `..` segment) and unknown nodes (404). Legitimate repo-relative paths
pass. The leaf-selection default (source extensions, excluding `*.test.*`) omits
non-source files from leaf nodes by design; directories always get a node, so no
directory is "over-blocked" out of the map.

## 2. Under-block
Staleness compares committed git oids by default, so uncommitted working-tree
edits are not flagged unless the opt-in dirty mode is used — intentional (committed
state is deterministic across machines). Summaries are stored verbatim and
semantically unverified; the map never asserts a summary is *true* — downstream
specs (#3/#5) must re-ground against code. The map only covers what `scaffold()`
walks (skip-set + maxDepth bounded).

## 3. Level-of-abstraction fit
Right layer. `CartographerTree` is a `src/core` data-structure module like
`ProjectMapper`; routes mount via the existing `createRoutes` context pattern; the
gate + instantiation live beside `projectMapper` in `server.ts`; the config default
rides the existing `applyDefaults` migration path (no bespoke migrator). The
skip-set is one shared export, not duplicated.

## 4. Blast radius / reversibility
Self-contained and dark by default — a fresh agent gets `cartographer.enabled:
false`, so the feature is inert (routes 503) until explicitly enabled. The only
change to existing code paths is `ProjectMapper` importing `DEFAULT_SKIP_DIRS` from
the new shared module (identical set; covered by ProjectMapper's existing tests,
which stay green). Removing the feature is deleting the module + routes; no schema
migration to undo. State lives under `.instar/cartographer/` (gitignored).

## 5. State / migration / multi-machine
New runtime state dir `.instar/cartographer/` (per-machine, gitignored, never
committed). Config default flows to existing agents via `migrateConfig` →
`applyDefaults` (existence-checked, idempotent). CLAUDE.md awareness flows via a
content-sniffed `migrateClaudeMd` block (idempotent). No cross-machine sync surface
— the tree is a local derived index, regenerable by `scaffold()` on any machine.

## 6. Security / abuse
`?path=` never builds a filesystem path — it indexes the in-memory node store; the
on-disk node filename is a sha256 slug, collision-free and not derived from request
input. All git access is read-only via `SafeGitExecutor.readSync` (arg-form, no
shell interpolation). Routes are Bearer-auth'd like all instar routes; writes have
no open route (in-process only). Summaries served as JSON (consumers escape before
any HTML render). `scaffold()` is bounded by maxDepth + a symlink-loop guard
(visited realpaths) so a pathological repo cannot hang it. The one destructive fs
path — pruning stale node files in `rewriteAll()` — is funneled through
`SafeFsExecutor.safeUnlinkSync` (operation-tagged `cartographer-prune-stale-node`,
source-tree-guarded with the agent-runtime-state carveout for `.instar/`), never a
raw `fs.unlinkSync`, so the destructive-fs lint and audit trail both cover it.

## 7. Observability / failure modes
`GET /cartographer/health` exposes node/authored/stale counts (the Tier-3 "alive"
surface). Absent git/HEAD degrades to "no current oids" → nodes read as
`never-authored`/`path-gone` rather than crashing (try/caught, `@silent-fallback-ok`).
`setSummary`'s node-then-index write is non-transactional: a crash between the two
leaves the index one version behind that node — a benign lag, self-healed by the
next `setSummary`/`scaffold`, never corruption. Tests cover all of: 14 unit + 8
integration (route contract) + 2 e2e (alive lifecycle), all green; `tsc --noEmit`
clean; ProjectMapper's existing tests stay green after the skip-set extraction.
