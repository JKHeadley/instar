---
title: "Conversational-action v0.2 — three on-demand catalog loaders"
slug: "conversational-action-v02"
author: "echo"
status: "converged"
type: "concept-spec"
parent: "specs/instar-concepts/conversational-action.md"
eli16-overview: "conversational-action-v02.eli16.md"
review-convergence: "2026-05-19T17:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T17:30:00Z"
review-report: "docs/specs/reports/conversational-action-v02-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode hybrid C, with explicit 2026-05-19 ack: 'please enter autonomous mode and complete ALL of these')"
approved-date: "2026-05-19"
approval-note: "Final v1.0 task. The v0.1 (PR #256) shipped the pure-data primitives (discoverActions + renderCatalogBlock) and deliberately omitted the always-on AGENT.md inlining (the bloat lesson Justin caught). This v0.2 wires the catalog through three on-demand loaders — ContextHierarchy Tier 2 segment, SelfKnowledgeTree probe, Playbook context item — so the agent can fetch it during intent-interpretation moments without ever inlining it into the always-loaded identity prompt."
lessons-engaged:
  - "P1 (Structure>Willpower): three structural on-demand loaders, not a docs request that agents fetch the catalog manually."
  - "L1 (AGENT.md bloat lesson — the lesson Justin caught in v0.1): the catalog is NEVER inlined into AGENT.md. All three loaders are on-demand. Test asserts the conversational-actions segment content is not in Tier 0/1 loads."
  - "L3 (Topology check): confirmed all three loaders fit existing systems — Tier 2 segment lives in ContextHierarchy DEFAULT_SEGMENTS, probe registers with selfKnowledgeTree.probes, Playbook item is a manifest template shipped via PostUpdateMigrator."
  - "P3 (Migration Parity): PostUpdateMigrator entry ships the Playbook manifest template idempotently. Existing agents get it on update."
  - "P4 (Testing Integrity): 6 new tests (3 ContextHierarchy + 3 migrator); existing 19 ContextHierarchy tests preserved; semantic correctness verified for both sides of the bloat boundary (Tier 1 NOT containing catalog + Tier 2 dispatch presence)."
  - "P10 (Comprehensive-First): all three loaders ship in v0.2; no recurrence-risking deferrals. The catalog itself is dynamic (lives in the probe), so we ship the dispatch+pointer infrastructure once and the catalog content updates automatically."
  - "L6 (Side-effects review): seven-dimension review at upgrades/side-effects/feat-conversational-action-v02.md."
  - "L9 (ELI16 required): conversational-action-v02.eli16.md sibling."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
---

# Conversational-action v0.2 — three on-demand catalog loaders

## What changed

Three coordinated changes that wire the v0.1 catalog primitives (`discoverActions` + `renderCatalogBlock` from PR #256) through Instar's pre-existing bloat-defense systems:

1. **`src/core/ContextHierarchy.ts`** — adds a new Tier 2 segment `conversational-actions` with triggers `interpreting-user-intent`, `matching-to-skill`, `translating-conversation-to-action`. The segment content (in `.instar/context/conversational-actions.md`) is the DISPATCH INSTRUCTION — it tells the agent how to fetch the live catalog via probe, NOT the catalog content itself. Per Tier 2 semantics, the segment only loads when one of its triggers fires.

2. **`src/commands/server.ts`** — registers a `conversational-catalog` probe with `selfKnowledgeTree.probes` at server boot. The probe calls `discoverActions(projectRoot)` + `renderCatalogBlock(actions)` and returns the live catalog as the probe content. The catalog is generated fresh on each probe invocation; no caching.

3. **`src/templates/playbook/conversational-catalog-manifest.json` + `src/core/PostUpdateMigrator.ts`** — ships a Playbook manifest template containing one item (`/instar/conversational-catalog`) that points at the ContextHierarchy segment file and the SelfKnowledgeTree probe. PostUpdateMigrator installs this template at `.instar/playbook/builtin-manifests/conversational-catalog.json` on every update; idempotent via content-sniff (skip if existing matches). Operators mount it via `instar playbook mount` (explicit consent per Playbook design). Once mounted, Playbook's scoring engine surfaces the catalog pointer on intent-interpretation triggers; the pointer references the segment + probe, never the catalog body.

## Why this ships now

Final v1.0 task. The v0.1 (PR #256) shipped the pure-data catalog primitives (`discoverActions`, `renderCatalogBlock`) and deliberately omitted the `applyCatalogBlock` API that would have written the catalog into AGENT.md. That omission was the bloat-aware design Justin caught — three already-built defenses (ContextHierarchy, Playbook, SelfKnowledgeTree) exist exactly to prevent AGENT.md bloat, so the catalog should route through them on-demand instead of always-on.

This PR wires those three loaders. The catalog content lives in the SelfKnowledgeTree probe (dynamic, generated at probe time). The ContextHierarchy Tier 2 segment is the DISPATCH instruction (tells the agent how to fetch). The Playbook item is the SCORING signal (decays based on relevance). Together, the three deliver intent-interpretation capability without ever bloating the always-loaded identity prompt.

## Design

### Topology

```
Layer 3 (Conversational-action) — this PR's wiring
  ├─ ContextHierarchy Tier 2 segment .instar/context/conversational-actions.md
  │    (dispatch instruction — how to fetch the catalog when an intent
  │     interpretation trigger fires)
  ├─ SelfKnowledgeTree probe `conversational-catalog`
  │    (the actual catalog renderer — calls discoverActions + renderCatalogBlock
  │     at probe time; no caching, always live)
  └─ Playbook manifest item /instar/conversational-catalog
       (relevance signal — Playbook's scoring engine surfaces this pointer
        when the agent is in an intent-interpretation moment; the pointer
        references the segment + probe, never the catalog body)

Layer 2 (catalog primitives — from PR #256)
  └─ src/providers/parity/conversationalActionCatalog.ts
       - discoverActions(projectRoot): walks .instar/skills/ → ConversationalAction[]
       - renderCatalogBlock(actions): markdown block as string
```

### Why all three loaders are required

Each loader serves a different role:

- **ContextHierarchy Tier 2 segment** — the dispatch table fires this segment when one of its triggers matches. The segment instructs the agent on HOW to fetch the catalog (probe call). This is the agent's "I should look this up" hint. Without it, the agent doesn't know the probe exists.

- **SelfKnowledgeTree probe** — when the agent decides to look up the catalog (from the segment's instruction OR from the Playbook item's surfacing OR from direct intent classification), it invokes the probe. The probe returns the LIVE catalog generated at call time. This is the authoritative source; both the segment and the Playbook item point at it.

- **Playbook item** — Playbook's scoring engine maintains a manifest of context items with usefulness scores, decay policies, and load triggers. The conversational-catalog Playbook item ensures the pointer is surfaced when an intent-interpretation trigger fires AND the agent's recent history suggests catalog lookup is relevant. This is the third on-demand load point: even if the Tier 2 segment hasn't been triggered explicitly, Playbook's scoring may surface the pointer.

Three load paths × three different selection mechanisms (trigger-based dispatch / probe-on-demand / scoring + relevance) give the catalog three independent on-ramps, none of which inline it into AGENT.md.

### Bloat-aware enforcement

The semantic correctness test for the conversational-actions segment asserts that:

1. The segment file exists at `.instar/context/conversational-actions.md`
2. Its content includes the probe name `conversational-catalog`, the word `on-demand`, and a reference to AGENT.md (i.e., explicitly tells the agent this is NOT inlined into AGENT.md)
3. The Tier 1 loadTier output does NOT contain the conversational-actions segment content
4. The dispatch table contains an entry for the segment with intent-interpretation triggers

These four assertions enforce structurally that the v0.2 wiring respects the AGENT.md bloat lesson (L1). Future PRs that accidentally inline the catalog into AGENT.md would fail the test suite.

### What this PR does NOT do

- Does not change the v0.1 catalog primitives (`discoverActions`, `renderCatalogBlock` keep their signatures). The pure-data abstraction was the right v0.1 shape; v0.2 just wires the consumers.
- Does not add `applyCatalogBlock`. The v0.1 deliberate omission was the bloat-aware design; v0.2 confirms that decision and wires through on-demand loaders instead.
- Does not auto-mount the Playbook manifest. The template file is installed at `.instar/playbook/builtin-manifests/`; operator runs `instar playbook mount` once (explicit consent per Playbook design). This is the right pattern — Playbook mounts are operator-initiated to preserve the "I chose to add this knowledge" invariant.
- Does not wire the HTTP endpoint `/capabilities/conversational-catalog`. The segment file mentions it as the third fallback after the probe, but it's not implemented in this PR. The probe is the canonical access path; the HTTP endpoint is a future convenience.

## Bootstrap exception

The lessons-aware reviewer (PR #260) is structurally in /spec-converge SKILL.md. Its content migration to deployed agents lands via the parity-renderings backfill (PR #262, now merged). Manual lessons-check applied transparently in the spec body — every P1-P10 plus relevant Ls walked.

### Manual lessons-aware check (vs `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`)

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — three structural on-demand loaders |
| P2 Signal vs Authority | ✓ Engaged — segment is the dispatch signal, probe is the authority |
| P3 Migration Parity | ✓ Engaged — PostUpdateMigrator ships the Playbook manifest template; idempotent |
| P4 Testing Integrity | ✓ Engaged — 6 new tests covering segment content, dispatch table, Tier-load exclusion, manifest install/idempotency/refresh |
| P5 Agent Awareness | N/A — internal wiring; the catalog is discovered, not requiring CLAUDE.md template additions |
| P6 Zero-Failure | ✓ Engaged — full ContextHierarchy + new migrator tests green |
| P10 Comprehensive-First | ✓ Engaged — all three loaders ship in v0.2 |
| L1 AGENT.md bloat | ✓ Direct fix — confirms v0.1's deliberate omission and adds the three on-demand defenses |
| L3 Topology check | ✓ Engaged — confirmed all three loaders fit pre-existing systems |
| L6 Side-effects review | ✓ Engaged — sibling file |
| L9 ELI16 required | ✓ Engaged — sibling ELI16 file |
| L10 Release notes in same PR | ✓ Engaged |
| B28 Spec-converge pre-auth circular | ✓ Engaged — this PR is the final v1.0 task per Justin's explicit autonomous-mode authorization |

No contradictions found. Zero deferrals (HTTP endpoint mentioned in segment is a documented future convenience, not a recurrence risk).

## Implementation slice for this PR

1. This spec + ELI16 + convergence report.
2. `src/core/ContextHierarchy.ts` — new Tier 2 segment + template generator.
3. `src/commands/server.ts` — `conversational-catalog` probe registration at boot.
4. `src/templates/playbook/conversational-catalog-manifest.json` (NEW) — Playbook manifest template.
5. `src/core/PostUpdateMigrator.ts` — new `migrateConversationalCatalogPlaybookManifest()` step.
6. `tests/unit/ContextHierarchy.test.ts` — 3 new tests.
7. `tests/unit/PostUpdateMigrator-conversationalCatalog.test.ts` — 3 new tests.
8. `upgrades/NEXT.md` + `upgrades/side-effects/feat-conversational-action-v02.md`.
9. Package.json version bump.
