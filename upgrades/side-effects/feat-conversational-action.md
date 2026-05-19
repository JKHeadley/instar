# Side-Effects Review — Conversational-action primitive v0.1 (bloat-aware catalog primitives)

**Version / slug:** `feat-conversational-action`
**Date:** 2026-05-19
**Author:** Echo (autonomous mode, hybrid C, amended after scope-coherence grounding pause)

## Summary of the change

Lands the Conversational-action primitive (Layer-3 required primitive #10) as **bloat-aware pure-data primitives**: `discoverActions` (walks installed canonical skills) + `renderCatalogBlock` (generates the catalog block as a string). 14 unit tests including a structural assertion that `applyCatalogBlock` is deliberately NOT exported.

**Amended scope (post-grounding):** the original draft included `applyCatalogBlock(projectRoot, actions)` that wrote directly into `.instar/AGENT.md`. The scope-coherence hook + Justin's explicit research request surfaced that this contradicts three existing Instar systems built specifically to prevent AGENT.md bloat:

- `ContextHierarchy` (`src/core/ContextHierarchy.ts`) — Tier 0/1/2 segments, "right context at right moment > all context all the time" (born from the Luna incident 2026-02-25)
- `Playbook` (`docs/PLAYBOOK-GETTING-STARTED.md`) — scored decaying context items
- `SelfKnowledgeTree` (`src/knowledge/SelfKnowledgeTree.ts`) — on-demand probe queries instead of memorized lists
- Plus the `Structure > Willpower` principle codified in CLAUDE.md template

`applyCatalogBlock` was removed from v0.1 to prevent baking the wrong placement decision into a primitive's surface. v0.2 wiring goes through the three infrastructures above (Tier 2 segment writer, `catalog` probe, Playbook item) — not direct AGENT.md insert.

**Files changed (specs):**
- specs/instar-concepts/conversational-action.md (new, converged + approved per pre-auth; includes "Bloat-awareness as a v0.1 design constraint" section)
- specs/instar-concepts/conversational-action.eli16.md (new)
- docs/specs/reports/conversational-action-concept-convergence.md (new — records the amended scope as iteration 2 finding)

**Files changed (source):**
- src/providers/parity/conversationalActionCatalog.ts (new — discoverActions + renderCatalogBlock only; applyCatalogBlock deliberately NOT exported)

**Files changed (tests):**
- tests/unit/providers/parity/conversationalActionCatalog.test.ts (new — 14 tests; includes structural assertion that applyCatalogBlock is absent from public API)

**Files changed (release notes):**
- upgrades/NEXT.md (new)
- package.json (version bump)

## Decision-point inventory

- **Building-block scope, bloat-aware**: ships `discoverActions` + `renderCatalogBlock` only. No direct AGENT.md write. Caller (v0.2 ContextHierarchy / SelfKnowledgeTree / Playbook wiring) decides where the block lands.
- **`applyCatalogBlock` removal**: structural prevention of AGENT.md bloat. Spec body documents why; one test enforces the public API surface.
- **Skill discovery enumerates all canonical skills**: `user-invocable: true` filter deferred to v0.2 (Skill v0.1 doesn't surface that field).
- **Catalog block format**: HTML-comment delimited (`<!-- instar:conversational-actions:start -->` / `:end -->`), stable + machine-readable, idempotent re-renders.
- **Discovery skip-on-error**: skills with broken YAML frontmatter or invalid slugs are silently skipped (Skill parity rule surfaces them separately as drift). Avoids double-reporting.
- **No registry entry**: catalog is consumed via direct import (matches Tool primitive precedent). v0.2 sentinel-wired drift detection is the registry consumer.
- **No I/O writes**: `discoverActions` reads `.instar/skills/`; `renderCatalogBlock` is pure function. Module never writes anywhere.

## Over-block / under-block analysis

**Over-block risk (catalog rendering):** none — block is pure data, never imposed on AGENT.md.

**Under-block risk (broken skills skipped):** a skill with malformed frontmatter is silently absent from the catalog. The Skill parity rule already surfaces this as drift on its own pass; v0.2 sentinel wiring will combine signals.

**Under-block risk (v0.2 not yet wired):** until v0.2 wires the catalog into ContextHierarchy / SelfKnowledgeTree / Playbook, the catalog data exists but nothing reads it. That's intentional — better to ship correct pure-data primitives now than to ship a half-baked wiring that bakes in the bloat path.

## Level-of-abstraction fit

- Catalog primitives are pure data — discovery + rendering. No I/O writes, no LLM calls, no AGENT.md awareness.
- Boundary clean: catalog OWNS the block format; doesn't OWN where it lands.
- Pure-function shape: `discoverActions`, `renderCatalogBlock` — composable with any downstream loading vehicle.

## Signal-vs-authority compliance

- Catalog is signal (here's what's invocable + when).
- Authority over loading placement: the v0.2 ContextHierarchy / SelfKnowledgeTree / Playbook integrations + ultimately the agent's runtime intent classifier.
- v0.2 authed POST endpoints will gate execution via trust — separate authority layer.

## Interaction surface

- One new file under `src/providers/parity/`. No HTTP routes, no server.ts wiring, no config additions, no AGENT.md writes.
- Reads `.instar/skills/<name>/SKILL.md`.
- No changes to existing rules, registries, scaffold, or migration paths.
- No new dependencies.

## Rollback cost

- Pure-add. Revert removes the module + tests + spec. No data migrations, no AGENT.md state to undo (because no writes).
- Worst-case bug: `renderCatalogBlock` produces malformed markdown. Mitigated by stability test + delimiter shape test.

## Test coverage

- Unit: 14 tests covering discovery (empty/single/multiple/sort/fallback/slug-filter/broken-YAML-skip/files-vs-dirs), rendering (empty placeholder, bullet shape, stability), end-to-end discover → render, **structural assertion that applyCatalogBlock is NOT in the public API** (enforces the bloat-aware design constraint at the test layer).
- Integration + E2E: not applicable for pure-data primitives. v0.2 wiring PR will add integration + E2E when HTTP/sentinel/segment-writer surfaces land.

## Documentation

- Concept spec + ELI16 at `specs/instar-concepts/` (both updated to lead with the bloat-awareness design constraint).
- Convergence report at `docs/specs/reports/` (iteration 2 records the bloat-aware amendment).
- NEXT.md with "What to Tell Your User" entries explaining the deliberately-narrow v0.1 scope.

## Deferred (tracked, not silent)

- **ContextHierarchy Tier 2 segment writer** that consumes `renderCatalogBlock` output → `.instar/context/conversational-actions.md` with triggers `interpreting-user-intent` / `answering-what-can-you-do` — v0.2.
- **SelfKnowledgeTree `catalog` probe** that returns matching actions for a query at runtime — v0.2.
- **Playbook context item** seeded with the catalog discovery pattern + decay configuration — v0.2.
- **FrameworkParitySentinel wiring** as a catalog-drift parity rule (catalog-out-of-sync detection on scan) — v0.2.
- **Authed POST /api/conversational/execute endpoints** — v0.2 with per-action shape declarations + trust integration.
- **`user-invocable: true` filter** — v0.2, pending Skill v0.2 field surface.
- **InstructionFile primitive** — separate spec, decides what minimal pointer (3 sentences max) goes into framework-native CLAUDE.md / AGENTS.md.
- **Intent-classification examples in skill frontmatter** — v0.2.

## Why this amendment matters

The pre-amendment v0.1 would have shipped `applyCatalogBlock` as the headline API, with a NEXT.md line saying "v0.2 will fix the bloat concern." That's the "Phase 2" anti-pattern Justin explicitly listed in this autonomous session's stop-hook brief: "every task has a concrete done state. No deferrals disguised as planning." Removing `applyCatalogBlock` makes the v0.1 surface honest — the primitive ships what it can ship correctly, and the wiring decision waits for the right loading vehicle to land.
