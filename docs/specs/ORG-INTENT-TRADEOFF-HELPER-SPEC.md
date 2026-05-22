---
title: ORG-INTENT Tradeoff Helper — Phase 3
status: approved
approved: true
approver: justin
approved-at: "2026-05-22T04:55:00Z"
approval-context: "Pre-authorized as Phase 3 of the four-phase org-intent runtime project. Justin's seed message (2026-05-21 15:50 PDT, topic 11378) requested recommendations; Justin approved the full four-phase scope (2026-05-21 21:54 PDT) with explicit \"Yes! Please proceed in an autonomous session.\""
review-convergence: "2026-05-22T06:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T06:30:00Z"
review-mode: "single-author, pre-authorized scope"
lessons-checked:
  - "feedback_signal_vs_authority — TradeoffResolver is pure deterministic SIGNAL (no authority over outcomes); the Coherence Gate from Phase 1 remains AUTHORITY for any value-alignment block."
  - "feedback_side_effects_review — full review at upgrades/side-effects/org-intent-tradeoff-helper.md."
  - "feedback_release_notes_in_same_pr — NEXT.md filled in this same PR."
  - "feedback_eli16_required_for_specs — companion at ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md."
  - "feedback_no_pr_fragmentation — Phase 3 ships as ONE PR; Phase 4 queues behind merge."
  - "feedback_spec_converge_pre_auth_circular — Justin pre-authorized the full four-phase scope; /spec-converge would be circular."
created: 2026-05-22
owner: echo
companion-eli16: ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md
eli16-overview: ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md
phase-of: ORG-INTENT-RUNTIME-GATE-SPEC.md
---

# ORG-INTENT Tradeoff Helper — Phase 3 Spec

> Make the tradeoff hierarchy from `ORG-INTENT.md` mechanically consultable: given two contending values, deterministically resolve which one wins per the organization's hierarchy.

**Status**: Implementation Complete (Phase 3)
**Companion**: `ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md`
**Author**: Echo (autonomous build, supervised by Justin)
**Origin**: Phase 3 of the four-phase ORG-INTENT runtime project. Phase 1 (`ORG-INTENT-RUNTIME-GATE-SPEC.md`) wired the gate; Phase 2 (`ORG-INTENT-SESSION-START-INJECTION-SPEC.md`) injected the contract at session-start; Phase 3 makes the hierarchy itself a deterministic standalone surface.

---

## Background

Phases 1 and 2 surfaced the tradeoff hierarchy from `ORG-INTENT.md` to the value-alignment reviewer (at gate-evaluate time) and to the agent's session-start context (as a labeled block). The reviewer can use the hierarchy to resolve values collisions via the LLM's contextual reasoning.

But other code paths — research agents, planning passes, future jobs, the agent itself when asked a direct "which value wins?" question — have no clean way to consult the hierarchy. They would have to fetch `GET /intent/org`, parse the structure, and implement their own resolution logic. That is the kind of duplication that breeds drift.

This phase factors the resolution logic out as a single deterministic helper, exposed via a single HTTP route, callable by any code path that needs a tie-break.

## Goal

Provide a pure, deterministic tradeoff resolver:

- Single function: given two value strings and the parsed `tradeoffHierarchy`, return `{ winner: 'A' | 'B' | null, basis, explanation, matchedIndexA, matchedIndexB }`.
- Single HTTP route: `POST /intent/tradeoff-resolve` accepts `{ valueA, valueB }` and returns the resolution.
- No LLM call. No fuzzy matching beyond case-insensitive substring containment. Predictable for any caller.

Non-goals (deferred to Phase 4):
- Phase 4: Periodic drift detection job — sample recent outbound actions, score vs intent, emit digest signal.

## Design

### Resolution algorithm

The helper applies three strategies in priority order:

1. **Pair-pattern match** — entries written as `"X over Y"` (or `"X before Y"`, `"X above Y"`, `"X trumps Y"`, `"X beats Y"`, `"X wins over Y"`). If both inputs match X and Y respectively, the stated winner is returned regardless of list position. This honors explicit pairwise statements over implicit list-order.

2. **List-order match** — each input is matched against hierarchy entries via case-insensitive substring containment. The input whose match lands at the earliest index wins. If only one input matches, that one wins. If both match at the same index without a pair pattern, returns `basis: 'tie'` for the reviewer to handle.

3. **No match** — neither input appears in the hierarchy. Returns `winner: null, basis: 'no-match'`. Caller decides what to do — typically: ask the LLM via the value-alignment reviewer.

### Surface changes

| File | Change |
|---|---|
| `src/core/TradeoffResolver.ts` | New file — pure `resolveTradeoff()` function + `TradeoffResolution` type |
| `src/server/routes.ts` | New `POST /intent/tradeoff-resolve` route |
| `src/scaffold/templates.ts` | CLAUDE.md ORG-INTENT subsection adds Phase 3 curl line |
| `src/core/PostUpdateMigrator.ts` | New migration path: Phase 1+2 CLAUDE.md → adds Phase 3 line. Phase-2-upgrade and fresh-section paths already include Phase 3 from this PR's template updates. |
| Spec + ELI16 + side-effects | This file + companion + `upgrades/side-effects/org-intent-tradeoff-helper.md` |
| NEXT.md | Filled |

### What the value-alignment reviewer does (no change)

The reviewer already receives the structured `tradeoffHierarchy` in its prompt via Phase 1's surfacing. It uses the hierarchy contextually via the LLM. The new TradeoffResolver is for callers OUTSIDE the reviewer flow — code paths that want a deterministic tie-break without paying for an LLM call. The reviewer remains the authority for any blocking decision.

## Testing

All three tiers per Testing Integrity Standard.

### Tier 1 — Unit

`tests/unit/TradeoffResolver.test.ts` (new file, 16 tests):
- Pair-pattern: `over` / `before` / `above` / `trumps` / `wins over` / `beats` patterns.
- List-order: A only, B only, both (earlier wins).
- Tie (both in same entry, no pair pattern).
- No-match (neither in hierarchy, empty hierarchy, empty inputs).
- Mixed format hierarchies — pair-pattern wins over list-order when both fire.
- Case-insensitive substring matching.

`tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` extended (8 tests total):
- New test: Phase 1+2 CLAUDE.md gains Phase 3 line on migration; idempotent on re-run.

### Tier 2 — Integration

`tests/integration/org-intent-routes.test.ts` extended (16 tests total):
- New tests for `POST /intent/tradeoff-resolve`: absent ORG-INTENT.md, list-order resolution, pair-pattern resolution, 400 on missing fields.

### Tier 3 — E2E lifecycle

`tests/e2e/org-intent-tradeoff-lifecycle.test.ts` (new file, 5 tests):
- Phase 1: route returns 200, not 503.
- Phase 2: pair-pattern resolution works end-to-end.
- Phase 3: list-order resolution works end-to-end.
- Phase 4: no-match returns null winner.
- Phase 5: 400 on missing valueA.

## Side effects

See `upgrades/side-effects/org-intent-tradeoff-helper.md`.

Summary: pure additive feature — one new module, one new route, two CLAUDE.md updates. No existing code paths are modified. No agent behavior changes unless something explicitly calls the new route.

## Migration

- Existing agents: `PostUpdateMigrator.migrateClaudeMd()` gains one new branch that adds the Phase 3 tradeoff-resolve curl line to CLAUDE.md when Phase 1+2 wording is already present. Idempotent.
- Fresh agents: `generateClaudeMd()` includes Phase 1+2+3 from the start.

## Open follow-ups (Phase 4, NOT this PR)

- Phase 4: periodic drift detection job sampling recent outbound actions vs intent.
- Per-channel constraint scoping.
- LLM-fallback for `no-match` cases — caller may want the resolver to optionally ask the value-alignment reviewer when deterministic resolution fails.
