# Convergence Report — Conversational action (Layer-3 primitive)

## ELI10 Overview

A **conversational action** is an Instar capability the agent can perform when the user asks for it in plain English instead of typing a slash-command. Justin's foundational stance, locked 2026-05-18: users should never have to know any Instar internals; the slash-command surface is a backstop, conversational is the default.

For the agent to do this well, it needs a *catalog* — a list of what's invocable, embedded in its identity (`.instar/AGENT.md`) so it's loaded on every session start. This spec defines the catalog primitive: a renderer that walks installed skills, generates a markdown block listing each one, and idempotently inserts that block into AGENT.md.

The agent then picks it up at session start and translates user intent into action.

## Original vs Converged

The original v0.1 sketch (in the FrameworkParitySentinel proposal) proposed bundling the catalog renderer with the sentinel itself. Convergence surfaced that this conflates two responsibilities: the sentinel walks parity rules; the catalog walks skills and writes AGENT.md. Different inputs, different outputs, different verifiers.

The converged spec scopes Conversational-action as its own Layer-3 primitive (matching the foundational `required-primitives-inventory.md` #10 entry). The catalog is `src/providers/parity/conversationalActionCatalog.ts` — discoverable + renderable + idempotently appliable. The wiring of "every X minutes, re-render catalog" lives in the FrameworkParitySentinel as a separate parity rule (v0.2 deferred).

The other change: dropping the `user-invocable: true` frontmatter filter for v0.1. The Skill primitive's v0.1 doesn't yet surface that field (deferred to Skill v0.2). Filtering on it now would silently drop all skills. Convention for v0.1: every canonical skill is user-invocable. v0.2 adds the filter once the field exists.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | abbreviated (pattern-instance + foundational-stance alignment) | 2 (catalog-vs-sentinel separation, user-invocable filter premature) | Split catalog into its own primitive; drop v0.1 filter, document v0.2 promotion |
| 2 | (would-have-converged but for F3 surfaced post-CI by scope-coherence pause) | 1 (applyCatalogBlock contradicts ContextHierarchy + Playbook + SelfKnowledgeTree) | Remove applyCatalogBlock from v0.1; document bloat-aware design constraint; add structural test |
| 3 | (converged) | 0 | none |

## Full Findings Catalog

**F1: Catalog vs sentinel responsibility split** — Severity: high. Reviewer perspective: integration. Original: spec proposed bundling catalog renderer into the FrameworkParitySentinel. Resolution: split into its own Layer-3 primitive `conversational-action`; catalog renderer lives under `src/providers/parity/` as a building block; sentinel-wired drift-detection deferred to v0.2 as a separate parity rule.

**F2: `user-invocable: true` frontmatter filter would drop all v0.1 skills** — Severity: high. Reviewer perspective: integration. Original: spec required filtering by `user-invocable: true`. Resolution: Skill v0.1 doesn't surface this field; filter deferred to v0.2 when Skill v0.2 adds it. v0.1 convention: every canonical skill is user-invocable.

**F3: `applyCatalogBlock` contradicts three existing AGENT.md-bloat defenses** — Severity: critical. Reviewer perspective: integration / architecture (surfaced post-CI by the scope-coherence stop hook + Justin's explicit research request "we've run into context bloat in the main CLAUDE.md/AGENT.md file where we get overloaded with too many critical awareness items"). Original: spec exported `applyCatalogBlock(projectRoot, actions)` that wrote the catalog block directly into `.instar/AGENT.md`. Resolution: removed `applyCatalogBlock` from v0.1 public API; documented bloat-awareness as a v0.1 design constraint in the spec; added a structural unit test that asserts `applyCatalogBlock` is NOT exported. v0.2 wiring routes through `ContextHierarchy` Tier 2 segment, `SelfKnowledgeTree` `catalog` probe, and `Playbook` context item — three systems already built to load context on demand, not always.

This finding was specifically the "Phase 2 anti-pattern" the autonomous-session stop-hook brief warned against. Documenting `applyCatalogBlock` as a v0.1 primary API with a v0.2 "will fix the bloat concern" note would have shipped the bloat path with planning-cover. Removing it makes the v0.1 surface honest.

## Convergence verdict

Converged at iteration 3 after a post-CI scope-coherence amendment. No material findings in the final round. The spec is approved (pre-authorized per hybrid C autonomous-mode agreement). The catalog ships as bloat-aware pure-data primitives; the AGENT.md-writing API is deliberately absent and structurally enforced. Sentinel + authed POST integration deferred to v0.2.

## Deviation note

Pattern-instance + substrate-bound abbreviated convergence — Conversational-action's full reviewer perspectives have been baked into the canonical-source-of-truth + per-framework rendering pattern via Skill convergence (the canonical input here IS the Skill primitive). The deviation from that pattern — no per-framework rendering, no AGENT.md insert — reflects the bloat-aware design constraint that loading-vehicle decisions belong to the InstructionFile / ContextHierarchy / Self-Knowledge Tree / Playbook infrastructures, not to this primitive's surface.
