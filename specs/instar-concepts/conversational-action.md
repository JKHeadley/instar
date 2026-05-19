---
title: "Conversational action — Instar concept spec"
slug: "conversational-action-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "conversational-action.eli16.md"
review-convergence: "2026-05-19T03:30:00Z"
review-iterations: 3
review-completed-at: "2026-05-19T03:30:00Z"
review-report: "docs/specs/reports/conversational-action-concept-convergence.md"
review-deviation: "Pattern-instance + substrate-bound. Abbreviated convergence with a post-CI amendment (iteration 2 → 3) when a scope-coherence pause + Justin's research request surfaced that the original `applyCatalogBlock` API contradicted ContextHierarchy + Playbook + SelfKnowledgeTree — three existing systems built to prevent AGENT.md bloat. v0.1 ships bloat-aware pure-data primitives only (discover + render); wiring deferred to v0.2 via the three loading-vehicle infrastructures."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check. Alignment verified: Layer-3 required primitive #10 in required-primitives-inventory.md; substrate dependencies (oneShotCompletion + agenticSession + contextScopeControl) match inventory; what-is-NOT bound respected (intent classification is the agent's runtime concern; canonical catalog data is this primitive's job; loading-vehicle placement is the InstructionFile/ContextHierarchy/SelfKnowledgeTree/Playbook layer). Post-CI amendment honors the Structure>Willpower principle by removing the AGENT.md-writing API rather than shipping it with a v0.2-will-fix-it sticker."
---

# Conversational action — Instar concept spec

## What this is

The tenth required Layer-3 primitive — and the densest user of substrate-LLM access in the inventory. **Conversational action** is the agent's ability to interpret natural-language config intent ("can we switch to a local model?", "add a skill that does X", "remediate the parity drift"), classify it against a known action catalog, ask clarifying questions if needed, and execute via an authed action endpoint.

**Foundational stance** (locked 2026-05-18, per Justin): Instar users should not need to know ANY Instar internals. Every aspect of Instar's functionality must be explorable conversationally; every config change must be doable conversationally on multiple levels. The agent maintains a high degree of self-awareness of its own architecture AND a responsibility to actively guide the user — suggesting config changes from stated needs, recognizing when a stated need maps to "you want a hook here" or "you want a new skill" without the user having to know hook/skill exist. The slash-command surface is a backstop, not the primary path.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #10 |
| Substrate dependencies | `oneShotCompletion` (intent classification + clarification), `agenticSession` (in-flight session that hears + dispatches), `contextScopeControl` (catalog reaches the agent at session start) |

## Definition

A **conversational action** is an executable agent capability with:
1. A natural-language **trigger** (one or more phrases the agent recognizes as intent for this action).
2. A canonical **invocation** path (typically: an installed Skill's slash-command).
3. A short **description** consumed by the agent at session-start for awareness.
4. (Optional, v0.2) An authed **action endpoint** for non-skill actions (e.g. config flips that aren't worth a full skill).

The set of conversational actions in v0.1 is the set of installed skills with `user-invocable: true` frontmatter. The catalog renderer enumerates them and exposes the resulting list as data; **routing that data into the agent's prompt context is NOT this primitive's job** — it belongs to the InstructionFile / ContextHierarchy / Self-Knowledge Tree infrastructure, which already has the bloat-aware loading patterns Instar has invested in.

## Bloat-awareness as a v0.1 design constraint

Instar has run into this trap three times already and built three structural defenses:

1. **`ContextHierarchy`** (`src/core/ContextHierarchy.ts`) — Tier 0/1/2 segment system. Born from the Luna incident (2026-02-25): without tiering, agents either load everything (bloat) or nothing (incoherence). Catalog content belongs in a Tier 2 segment under `.instar/context/conversational-actions.md`, triggered by intents like `interpreting-user-intent` / `answering-what-can-you-do` — NOT inlined into AGENT.md (Tier 0, always-loaded).
2. **`Playbook`** (`docs/PLAYBOOK-GETTING-STARTED.md`) — scored manifest of context items with decay. A "catalog discovery" Playbook item with token budget + trigger + usefulness score ensures the catalog earns its tokens or ages out.
3. **`SelfKnowledgeTree`** (`src/knowledge/SelfKnowledgeTree.ts`) — discoverable knowledge; agents query `/self-knowledge/search?q=...` on demand instead of memorizing. A `catalog` probe in `ProbeRegistry` returns matching actions for an intent query at runtime.

The **Structure > Willpower** principle codified in `CLAUDE.md`: a 1000-line prompt is a wish; a 10-line hook is a guarantee. The catalog must NOT bloat the always-loaded prompt.

This means v0.1 ships pure-data primitives only — **no direct AGENT.md write**. The v0.2 wiring goes through the three infrastructures above, not into AGENT.md inline.

## What this primitive renders

The Conversational-action primitive's renderer in v0.1 owns:

1. **Catalog discovery** — walk `.instar/skills/<name>/SKILL.md` (the canonical Skill primitive root). Extract `name` + `description` + slash-command (typically `/<name>`). v0.1 enumerates ALL canonical skills (the `user-invocable: true` frontmatter filter is deferred to v0.2 when the Skill primitive's v0.2 work surfaces that field; current convention is that every canonical skill is user-invocable).
2. **Catalog rendering as data block** — generate a stable markdown block (with start/end delimiter comments) suitable for embedding in a Tier 2 ContextHierarchy segment (NOT in AGENT.md directly):

   ```markdown
   <!-- instar:conversational-actions:start -->
   ## Conversational Actions

   When the user expresses intent that maps to one of these, invoke the slash-command (or guide them conversationally to the equivalent action). You don't need to surface the slash-command name to the user — translate.

   - `/spec-converge <path>` — Run a converged spec review pass. Use when the user wants to validate or revise a spec design.
   - `/local-model` — Switch the active model to a locally-hosted alternative. Use when the user mentions cost, privacy, or wants to "go offline."
   - ...
   <!-- instar:conversational-actions:end -->
   ```

3. **No `applyCatalogBlock` API** — v0.1 deliberately does NOT ship a function that writes this block to AGENT.md. The block is returned as a string. The caller (v0.2 ContextHierarchy segment writer, Self-Knowledge Tree probe handler, or InstructionFile primitive) decides where it lands. This is the bloat-aware structural choice.

A conversational action is NOT:
- A skill (skills are the rendered invocation target).
- A hook (hooks are reactive scripts).
- A slash-command-or-equivalent primitive (that's #8 — the framework-native slash-command surface). Conversational-action is the LAYER ABOVE that translates intent → invocation.
- An LLM-routing decision (routing is substrate's `oneShotCompletion`).

## v0.1 scope

The renderer is the load-bearing artifact:

- `src/providers/parity/conversationalActionCatalog.ts` exports:
  - `discoverActions(projectRoot)` — walk canonical skills, return `Array<ConversationalAction>`.
  - `renderCatalogBlock(actions)` — generate the markdown block (with start/end markers) as a string.

These are pure-data primitives — no I/O beyond reading canonical skills, no AGENT.md writes. Composable with any downstream loading vehicle.

**Deliberately NOT shipped in v0.1**:
- `applyCatalogBlock(...)` — the function that would write the block directly to AGENT.md. Excluded because it bakes in the wrong placement decision (Tier 0 inline write), which contradicts `ContextHierarchy`, `Playbook`, and `SelfKnowledgeTree` patterns. v0.2 wiring goes through those instead.

The catalog block (a string) is consumed by downstream Layer-3 primitives:
- **`ContextHierarchy` Tier 2 segment writer** (v0.2 wiring) — writes the block into `.instar/context/conversational-actions.md` with triggers `interpreting-user-intent`, `answering-what-can-you-do`. Loaded on demand, not always.
- **`SelfKnowledgeTree` `catalog` probe** (v0.2 wiring) — returns matching actions for a query at runtime; agent doesn't memorize the list.
- **`Playbook` context item** (v0.2 wiring) — adds the catalog discovery pattern as a scored item that decays if unused.
- **InstructionFile primitive** (separate spec, next) — may carry a minimal pointer (3 sentences max) into framework-native instruction files referring to the catalog endpoint, NOT the full list.

v0.1 does NOT ship:
- Authed POST action endpoints (`POST /api/conversational/execute`) — v0.2.
- Intent classification (the agent does this at runtime via its own LLM; we provide the catalog, not the classifier).
- Per-action action-shape declarations (JSON Schema for params) — v0.2 with POST endpoints.
- Slash-command-or-equivalent canonical (that's primitive #8 — separate spec).

## What is NOT part of the Conversational-action primitive

- **Intent classification at runtime** — the agent does this with its own LLM access (substrate's `oneShotCompletion`). This primitive owns the *catalog*, not the *classifier*.
- **Action execution mechanism** — actions invoke via slash-command (Skill primitive's responsibility) or future authed POST endpoints (v0.2).
- **Trust gating of action execution** — substrate's trust system + the future POST endpoints will handle this.

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive #10. The catalog is framework-agnostic (lives in canonical AGENT.md); InstructionFile primitive carries it into framework-native instruction files.
- **`required-primitives-inventory.md`**: Substrate dependencies match exactly. v0.1 scope honors "user should not need to know any Instar internals" by surfacing actions as natural-language triggers, not slash-command syntax.
- **Signal-vs-authority compliance**: catalog is signal (here's what's invocable + when). The agent's runtime intent-classification is the authority. v0.2 authed endpoints will gate execution via trust.

## v0.1 deferred items

- **Authed POST action endpoints** (`POST /api/conversational/execute?action=<name>`) — v0.2, requires per-action action-shape declarations + trust integration.
- **Intent-classification examples / training** — each skill's frontmatter could carry `intent-examples: [...]` to seed the agent's classification. v0.2.
- **Non-skill conversational actions** — config flips, simple toggles. v0.2 with authed endpoints.
- **Catalog-drift parity rule** — the catalog block in AGENT.md is rendered from installed skills; if a skill is added/removed and the catalog isn't re-rendered, it's drift. v0.2 wiring into the FrameworkParitySentinel will detect this.
- **InstructionFile primitive integration** — the catalog block needs to land in framework-native CLAUDE.md / AGENTS.md. Comes with InstructionFile primitive (separate, next).

## Implementation slice for this PR

1. This concept spec + ELI16.
2. `src/providers/parity/conversationalActionCatalog.ts` — discovery + rendering + idempotent insert helpers.
3. Unit tests covering: skill discovery, frontmatter filtering, markdown rendering shape, idempotent re-render (no drift on repeated apply), missing-AGENT.md fail-loud.
4. Convergence report.
5. NEXT.md + side-effects + trace + version bump.
