# Side-Effects Review — Cartographer Subtree Navigation (spec #5, Tier 2)

**Version / slug:** `cartographer-subtree-nav`
**Date:** `2026-06-10`
**Author:** `Echo`
**Spec:** `docs/specs/CARTOGRAPHER-SUBTREE-NAV.md` (converged 1 round + a focused buildability review, approved)
**Second-pass reviewer:** `not required — convergence pinned the collapse rule, the two-phase scoring, batched fresh, and the migrator-only classification; this review covers the seven dimensions on the as-built deterministic code`

## Summary of the change

The capstone of cartographer-conformance: a **deterministic recursive navigator** over
the doc-tree. Given a query, it walks the tree's summaries top-down (a bounded frontier,
not all N nodes), scores nodes by relevance, and returns the **minimal relevant
subtree** — the paths a sub-agent should be scoped to instead of the whole repo.
`GET /cartographer/navigate`. Observe-only, deterministic-first; an optional LLM re-rank
is a dark structural stub. Dark behind `cartographer.enabled`.

## Files touched

- NEW `src/core/CartographerNavigator.ts` (scoring + the bounded recursive walk + collapse + sanitization).
- MODIFIED (additive): `src/core/CartographerTree.ts` (one public `currentOidMap()` accessor exposing the existing batched `currentOids()` — for batched `fresh`), `src/config/ConfigDefaults.ts` (`cartographer.subtreeNav`), `src/server/routes.ts` (the navigate route), `src/server/CapabilityIndex.ts`, `src/core/PostUpdateMigrator.ts` (CLAUDE.md section), `tests/unit/feature-delivery-completeness.test.ts` (legacy-migrator allowlist entry).
- TESTS: 32 across 3 tiers.

## 1. Over-block

The navigator blocks nothing (observe-only — it returns a suggestion). No gate.

## 2. Under-block / correctness

A bounded walk could MISS a relevant deep node if an intermediate dir's provisional
score gates it out. The build resolved this (a documented decision): the provisional
dir score peeks at descendant path BASENAMES to a bounded depth (PEEK_DEPTH=2, path-only,
non-recursive in score — no deadlock), so the spec's own example ("relevant code under
`src/messaging/`") and the "never-swept tree navigates on path signal" requirement hold.
A dir never enters `relevantPaths` on a single descendant's strength — only via the
collapse rule (≥0.6 of VISITED children relevant). `summaryCoverage` is reported so a
caller knows how much ranking was summary-informed vs path-only (honest on a never-swept
tree).

## 3. Level-of-abstraction fit

Pure scorer + pure walk in `CartographerNavigator`; the route is a thin read surface;
the tree exposes one new read accessor. No layer reaches across; the navigator takes the
tree + query and returns a manifest. Fully unit-testable on a fixture tree.

## 4. Determinism / cost (the cartographer-project footgun this avoids)

The shipped value is 100% deterministic — local index/summary reads only; zero token
cost, zero egress, byte-identical run-to-run. The bounded frontier (top-`branchingFactor`
children to `maxDepth`, capped by `maxNodesVisited`/`maxResults`) means cost is
O(frontier), not O(tree); `fresh` is one batched `git ls-tree`, not per-node. The LLM
re-rank ships OFF (Signal vs. Authority — the deterministic score is the authority).

## 5. Security / data-egress

- **Zero egress** in the default config (deterministic core). The optional LLM re-rank
  inherits spec #2's posture (off-Claude probe, separate egress-ack) and ships OFF.
- **Summaries are untrusted on output (the hard safety contract):** every emitted summary
  passes `neutralizeInstructionShapedContent` then `delimitUntrusted` — so a summary that
  smuggled "ignore your instructions" reaches the downstream sub-agent as quoted,
  declawed data, never an instruction. (A Tier-1 test asserts an instruction-shaped
  summary is emitted as `[neutralized: …]`.) The route consumes NO path input (paths are
  produced), so there is no traversal surface; `query` length + numeric bounds are
  validated (400 on violation).

## 6. Failure modes / load

No poller, no background work — the navigate is a synchronous read per request, bounded.
Empty query short-circuits. A never-swept tree degrades gracefully to path navigation.
No load impact.

## 7. Migration / compatibility (Migration Parity)

`cartographer.subtreeNav` nests under `cartographer` (deep-merge backfill — no
migrateConfig). The CLAUDE.md section ships via `migrateClaudeMd` (own marker 'Scope a
sub-agent to a subtree', idempotent) and is registered in the feature-completeness test's
`legacyMigratorSections` allowlist — EXACTLY as specs #1/#2/#3's cartographer sections
(migrator-only, not `generateClaudeMd`/shadow; verified at convergence). The route is in
CapabilityIndex. The `currentOidMap()` addition to CartographerTree is purely additive
(exposes an existing private read). Rollback: disabling `cartographer.enabled` 503s the
route. No migration reversal.
