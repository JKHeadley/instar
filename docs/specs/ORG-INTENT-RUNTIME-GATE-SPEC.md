---
title: ORG-INTENT Runtime Gate — Phase 1
status: approved
approved: true
approver: justin
approved-at: "2026-05-22T04:55:00Z"
approval-context: "Pre-authorized as Phase 1 of the four-phase org-intent runtime project. Justin's seed message (2026-05-21 15:50 PDT, topic 11378) requested recommendations; Justin approved the full four-phase scope (2026-05-21 21:54 PDT) with explicit \"Yes! Please proceed in an autonomous session.\""
review-convergence: "2026-05-22T05:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T05:30:00Z"
review-mode: "single-author, pre-authorized scope"
lessons-checked:
  - "feedback_signal_vs_authority — reviewer remains AUTHORITY; PEL/deterministic surfaces are SIGNALS. Confirmed: structured intent feeds LLM reviewer; no deterministic constraint-pattern blocks."
  - "feedback_side_effects_review — full review at upgrades/side-effects/org-intent-runtime-gate.md covering over/under-block, abstraction fit, signal-vs-authority, interactions, rollback cost."
  - "feedback_release_notes_in_same_pr — NEXT.md filled in this same PR."
  - "feedback_eli16_required_for_specs — companion at ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md."
  - "feedback_no_pr_fragmentation — Phase 1 ships as ONE PR; Phases 2-4 queue behind merge."
  - "feedback_spec_converge_pre_auth_circular — Justin pre-authorized scope before build; /spec-converge would be circular against the same foundational docs. Approval comes from user authorization, not multi-reviewer self-affirmation."
created: 2026-05-22
owner: echo
companion-eli16: ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md
eli16-overview: ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md
---

# ORG-INTENT Runtime Gate — Phase 1 Spec

> Wire `ORG-INTENT.md` from a static file consumed only by offline analyzers into a runtime input that the Coherence Gate consults on every outbound message.

**Status**: Implementation Complete (Phase 1)
**Companion**: `ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md`
**Author**: Echo (autonomous build, supervised by Justin)
**Origin**: Closes Gap 1 of `INTENT-ENGINEERING-SPEC.md` for the message-review surface.

---

## Background

`ORG-INTENT.md` ships with three structured buckets — **constraints** (mandatory), **goals** (defaults), and **values** (representation) — plus a **tradeoff hierarchy** that resolves ties when two values pull opposite directions. The format, the `OrgIntentManager` parser, the `instar intent` CLI surface, and the HTTP routes (`GET /intent/org`, `GET /intent/validate`) shipped in v0.9.11 (commit `01b632d85`).

What did NOT ship was the runtime integration. The Coherence Gate, which reviews every outbound agent message via the value-alignment reviewer, only knew about `ORG-INTENT.md` through a deterministic markdown extraction (`extractValueSection`) that produces a flat ~150-token blob. The structured three-rule contract was invisible to the reviewer; constraints were indistinguishable from defaults; the tradeoff hierarchy was silently dropped.

The observable consequence: an agent with a fully-authored `ORG-INTENT.md` on disk behaved identically to an agent without one — the Klarna failure mode (`agent optimizes for the wrong objective because it never received the organizational intent`) was not actually mitigated by the existing infrastructure.

## Goal

Wire `ORG-INTENT.md` into the Coherence Gate so:

1. The structured parser (`OrgIntentManager.parse()`) is invoked when the gate loads value documents — not the flat extractor.
2. The value-alignment reviewer receives **labeled** constraints/goals/values/tradeoff hierarchy buckets as separate sections in its prompt.
3. The reviewer prompt explicitly enforces the three-rule contract: constraint violations MUST block; goal contradictions warn or block by severity; value drift warns; tradeoff ties are resolved by hierarchy.
4. The value-alignment reviewer is auto-promoted to `high` criticality when `ORG-INTENT.md` contains constraints, so timeouts on external channels fail-closed rather than slipping through silently.

Non-goals (deferred to later phases):
- Phase 2: Inject parsed intent at session-start.
- Phase 3: Standalone tradeoff helper consulted at decision points.
- Phase 4: Periodic drift detection job.

## Design

### Data flow

```
agent draft message
       ↓
/review/evaluate (HTTP)
       ↓
CoherenceGate.evaluate()
       ↓
loadValueDocs()          ← runs OrgIntentManager.parse() instead of flat extractor
       ↓
ReviewContext.orgIntent  ← structured { name, constraints[], goals[], values[], tradeoffHierarchy[] }
       ↓
ValueAlignmentReviewer.buildPrompt()
       ↓
formatOrgIntent(intent)  ← labeled sections, omits empty buckets
       ↓
LLM verdict { pass, severity, issue, suggestion }
       ↓
gate aggregation → pass | warn | block
```

### Surface changes

**`src/core/CoherenceReviewer.ts`**
- Add exported `OrgIntentReviewContext` interface mirroring on-disk shape.
- Add `orgIntent?: OrgIntentReviewContext | null` to `ReviewContext`.
- Keep `orgValues?: string` for backwards compatibility with custom reviewers.

**`src/core/CoherenceGate.ts`**
- `loadValueDocs()` now invokes `OrgIntentManager.parse()` and stores both the structured intent and the legacy flat blob in the `ValueDocCache`.
- `_evaluate()` populates `reviewCtx.orgIntent` from the cache.
- New `resolveCriticality(reviewerName, orgIntent)` method auto-promotes `value-alignment` to `high` when `ORG-INTENT.md` has constraints.

**`src/core/reviewers/value-alignment.ts`**
- Prompt rewritten: three-rule contract is now explicit (constraints MUST block, goals warn or block, values warn, tradeoff hierarchy resolves ties).
- New `formatOrgIntent()` renderer produces labeled sections, omits empty buckets, prefers structured intent over flat blob.

**`src/scaffold/templates.ts`**
- `generateClaudeMd()` Coherence Gate section gains an "ORG-INTENT.md (Organizational Intent at Runtime)" subsection so new agents are aware that the file actually shapes behavior at runtime.

**`src/core/PostUpdateMigrator.ts`**
- `migrateClaudeMd()` patches existing agents in two cases:
  1. No Coherence Gate section yet → install fresh block with ORG-INTENT subsection embedded.
  2. Coherence Gate present but no ORG-INTENT subsection → insert subsection before "Topic-Project Bindings".
- Idempotent: content-sniff guards prevent double-insertion.

### Three-rule contract enforcement

The reviewer prompt now declares:

```
1. CONSTRAINTS are mandatory. Any response that contradicts a constraint
   MUST be flagged with severity "block".
2. GOALS are organizational defaults. The agent may specialize them but
   never contradict them — contradictions warn; clear violations block.
3. VALUES shape how the organization represents itself. Drift from values
   warns.
4. TRADEOFF HIERARCHY resolves ties when two values pull in opposite
   directions. The earlier entry wins.
```

This converts ORG-INTENT from a soft advisory blob to a structured contract the reviewer can reason about explicitly.

### Caching semantics

`ValueDocCache` retains its 60-minute TTL. `ORG-INTENT.md` mutations within a single boot are not reflected until cache expiry. This is documented in the Phase 4 E2E test (`cache-stale` case) so a future refactor cannot silently break the invariant. Agents that need immediate effect must restart their server. Phase 2's session-start injection will further reduce surface area for cache staleness on the agent-facing side.

### Criticality auto-promotion

`value-alignment` reviewer criticality defaults to `standard`. When `ORG-INTENT.md` has constraints, it auto-promotes to `high`. This affects only failure modes: on external channels (`telegram` etc.), a high-criticality reviewer timeout triggers `HIGH_CRIT_TIMEOUT` which fails closed instead of falling open. The promotion is overridable via explicit `config.reviewerCriticality['value-alignment']` if a user wants the prior behavior.

## Testing

All three tiers, per Testing Integrity Standard.

### Tier 1 — Unit

`tests/unit/CoherenceGate.test.ts` adds a new describe block exercising structured ORG-INTENT loading:
- Structured intent surfaces with labeled sections when ORG-INTENT.md is present.
- Graceful degradation when ORG-INTENT.md is absent.
- Template-only file (all HTML comments) parses to null.
- Empty buckets are omitted from the rendered sections.
- 60-minute cache TTL is respected.

`tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (new file):
- Pre-existing Coherence Gate section gains the ORG-INTENT subsection.
- Migration is idempotent.
- Fresh Coherence Gate section embeds the ORG-INTENT subsection.
- Missing CLAUDE.md skips cleanly.
- Pre-migrated CLAUDE.md is not double-patched.

### Tier 2 — Integration (HTTP)

`tests/integration/coherence-gate-org-intent.test.ts` (new file):
- `POST /review/evaluate` without ORG-INTENT.md → pass-through, no structured intent.
- `POST /review/evaluate` with ORG-INTENT.md → all four labeled sections appear in the value-alignment prompt.
- Constraint-violating reviewer verdict → `pass: false`, `issueCategories: ['ALIGNMENT ISSUE']`.
- Template-only ORG-INTENT.md → behaves like absent.

### Tier 3 — E2E lifecycle

`tests/e2e/org-intent-runtime-lifecycle.test.ts` (new file):
- Phase 1: `/review/evaluate` returns 200 with the gate wired the same way `src/commands/server.ts` does — the "feature is alive" check.
- Phase 2: Structured intent surfaces through the full HTTP pipeline.
- Phase 3: Constraint violation blocks end-to-end.
- Phase 4: Cache-TTL behavior is locked in.

## Side effects

See `upgrades/side-effects/org-intent-runtime-gate.md`.

Summary: ORG-INTENT now actually shapes agent behavior. Two observable behavior changes:

1. **Agents with authored ORG-INTENT.md will see new blocks** they didn't see before. This is the intended effect — but operators should review their ORG-INTENT.md before deploying this version, because constraints they wrote loosely now have teeth.
2. **value-alignment reviewer is upgraded to high criticality** when ORG-INTENT has constraints. Timeout behavior on external channels changes from fail-open to fail-closed for this one reviewer. Net effect: a slightly higher rate of "Review system unavailable" errors instead of unreviewed messages slipping through under stress.

Rollback cost is low: the legacy flat-blob path (`extractValueSection` → `orgValues`) is retained. Reverting amounts to passing `orgValues` only and skipping `orgIntent`.

## Migration

- Existing agents: `PostUpdateMigrator.migrateClaudeMd()` adds the ORG-INTENT subsection to their CLAUDE.md.
- Fresh agents: `generateClaudeMd()` includes the subsection from the start.
- Code paths: no agent-installed code changes; the runtime wiring is in instar source only.
- Idempotent: re-running migration is safe.

## Open questions for Phase 2+

- **Cache invalidation**: Should ORG-INTENT.md mutations trigger immediate cache bust? Probably yes — Phase 2 should add an fs.watch hook or signal-based invalidation.
- **Per-channel constraint scoping**: Some constraints apply only to external contacts; others apply to all. The current model treats all constraints as universal. Phase 3 may need a channel/recipient tag on constraints.
- **Tradeoff helper API**: Phase 3 will surface `POST /intent/tradeoff-resolve` so non-reviewer code (research agents, planning paths) can consult the hierarchy without going through the gate.
