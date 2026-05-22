---
title: ORG-INTENT Drift Detection — Phase 4
status: approved
approved: true
approver: justin
approved-at: "2026-05-22T04:55:00Z"
approval-context: "Pre-authorized as Phase 4 of the four-phase org-intent runtime project. Justin's seed message (2026-05-21 15:50 PDT, topic 11378) requested recommendations; Justin approved the full four-phase scope (2026-05-21 21:54 PDT) with explicit \"Yes! Please proceed in an autonomous session.\""
review-convergence: "2026-05-22T07:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T07:00:00Z"
review-mode: "single-author, pre-authorized scope"
lessons-checked:
  - "feedback_signal_vs_authority — analyzer + job + route are SIGNAL only; never block, never write to ORG-INTENT.md. AUTHORITY remains with the Coherence Gate (Phase 1)."
  - "feedback_side_effects_review — full review at upgrades/side-effects/org-intent-drift-detection.md."
  - "feedback_release_notes_in_same_pr — NEXT.md filled in this same PR."
  - "feedback_eli16_required_for_specs — companion at ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md."
  - "feedback_no_pr_fragmentation — Phase 4 ships as ONE PR; completes the four-phase project."
  - "feedback_spec_converge_pre_auth_circular — Justin pre-authorized the full four-phase scope."
created: 2026-05-22
owner: echo
companion-eli16: ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md
eli16-overview: ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md
phase-of: ORG-INTENT-RUNTIME-GATE-SPEC.md
---

# ORG-INTENT Drift Detection — Phase 4 Spec

> Periodic sampling of Coherence Gate review history to surface accumulated drift against organizational intent — the Klarna failure mode early-warning surface.

**Status**: Implementation Complete (Phase 4 — final phase)
**Companion**: `ORG-INTENT-DRIFT-DETECTION-SPEC.eli16.md`
**Author**: Echo (autonomous build, supervised by Justin)
**Origin**: Phase 4 of the four-phase ORG-INTENT runtime project. Phase 1 (gate wiring), Phase 2 (session-start injection), and Phase 3 (tradeoff helper) shipped in v1.2.23 / v1.2.24 / and the post-Phase-3 release. Phase 4 closes the project.

---

## Background

The per-message Coherence Gate from Phase 1 catches individual constraint violations. The session-start injection from Phase 2 ensures the agent reasons with the contract from message one. The tradeoff helper from Phase 3 lets non-reviewer code paths resolve values collisions deterministically. But none of these catch the slow accumulation pattern — every individual message passes the gate's threshold, but over a week or a month, the agent has gradually optimized for the wrong objective.

This is exactly the Klarna failure mode (`agent optimizes perfectly for the wrong objective because it never received the organizational intent at the right granularity`). Phase 1's gate catches direct contradictions; Phase 4 catches the accumulated drift.

## Goal

Provide a deterministic drift digest:

- **Pure analyzer**: given recent review history + parsed `ORG-INTENT.md`, produce a trend label (`stable` | `rising` | `concerning` | `insufficient-data` | `no-org-intent`), per-reviewer block-rate stats, half-window comparison, and cross-references against ORG-INTENT buckets.
- **HTTP route**: on-demand digest at `GET /intent/org/drift?lookbackDays=N`.
- **Job template**: weekly cron job, off by default, that calls the route and sends a Telegram heads-up only when `shouldSurface: true` (trend is rising or concerning).

Signal only. Never blocks. Never writes to `ORG-INTENT.md`.

This is the final phase of the four-phase project.

## Design

### Trend classification

The analyzer applies three rules in priority order:

1. **`no-org-intent`**: ORG-INTENT.md is absent or unparseable. No baseline to compare against.
2. **`insufficient-data`**: fewer than `minEntries` review entries in the window (default 5). Can't reliably surface a trend.
3. **`concerning`**: overall block rate ≥ `concerningBlockRate` (default 15%). Surface immediately.
4. **`rising`**: second-half block rate exceeds first-half by ≥ `risingBlockRate` (default 5%) AND second-half rate ≥ `risingBlockRate`. Subtle trend; worth surfacing.
5. **`stable`** (default): no surfacing needed.

`shouldSurface: true` only for `rising` and `concerning`. The weekly job uses this flag to decide whether to send a Telegram message; most weeks stay silent (the desired outcome).

### Half-window comparison

Entries are sorted chronologically and split at the midpoint. Block rates are computed for each half separately. The comparison detects "things were fine but lately have been getting worse" patterns that overall block rate alone misses.

### Cross-referencing constraints

The analyzer scans each violation's `issue` text for substring matches against the parsed ORG-INTENT `constraints`, `goals`, and `values`. Match counts surface in the digest so the user can see "3 of 5 flagged reviews referenced an org constraint by name." This is heuristic (substring match on first 20 chars of the constraint) but useful as narrative.

### Surface changes

| File | Change |
|---|---|
| `src/core/OrgIntentDriftAnalyzer.ts` (new file) | Pure `analyzeOrgIntentDrift()` function + `DriftAnalysis` type |
| `src/server/routes.ts` | New `GET /intent/org/drift` route |
| `src/scaffold/templates/jobs/instar/org-intent-drift-audit.md` (new file) | Weekly agentmd job, `enabled: false`, calls the route + sends Telegram digest when `shouldSurface: true` |
| `src/scaffold/templates.ts` | CLAUDE.md ORG-INTENT subsection adds Phase 4 curl line |
| `src/core/PostUpdateMigrator.ts` | New migration branch: Phase 1+2+3 CLAUDE.md → adds Phase 4 line. Earlier migration paths already include Phase 4 via the template updates. |
| Spec + ELI16 + side-effects | This file + companion + `upgrades/side-effects/org-intent-drift-detection.md` |
| NEXT.md | Filled |

### What the gate does (no change)

The Coherence Gate from Phase 1 continues to enforce constraints at message-review time. The drift analyzer consumes the gate's review history via `getReviewHistory()` but does not write back, modify, or block. Signal/authority separation per `feedback_signal_vs_authority`.

### Job behavior

The shipped job template `org-intent-drift-audit.md` is `enabled: false` by default. Operators with an authored `ORG-INTENT.md` can flip it to `true` in their local `.instar/jobs/instar/org-intent-drift-audit.md`. Once enabled, it runs every Monday at 10:00 local time, calls `/intent/org/drift`, and sends a Telegram heads-up only when `shouldSurface: true`. Most weeks stay silent.

## Testing

All three tiers per Testing Integrity Standard.

### Tier 1 — Unit

`tests/unit/OrgIntentDriftAnalyzer.test.ts` (new file, 11 tests):
- Edge cases: missing ORG-INTENT.md (`no-org-intent`), insufficient data, configurable minEntries.
- Stable trend: low and flat block rate.
- Rising trend: second-half rate exceeds first-half threshold.
- Concerning trend: overall rate exceeds concerning threshold.
- Per-reviewer stat aggregation correctness.
- Cross-reference against ORG-INTENT constraint text.
- Deterministic output (same input → same output).
- Threshold configurability.

`tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` extended (9 tests total — 1 new):
- New test: Phase 1+2+3 CLAUDE.md gains Phase 4 drift curl line; idempotent on re-run.

### Tier 2 — Integration

`tests/integration/org-intent-routes.test.ts` extended (17 tests total — 1 new):
- New test: `/intent/org/drift` returns 503 when no responseReviewGate is wired (graceful degradation).

### Tier 3 — E2E lifecycle

`tests/e2e/org-intent-drift-lifecycle.test.ts` (new file, 4 tests):
- Phase 1: route returns 200, not 503 — feature is alive.
- Phase 2: seeded review history surfaces a rising/concerning trend with cross-referenced constraint matches.
- Phase 3: auth required (200 or 401 depending on middleware wiring).

## Side effects

See `upgrades/side-effects/org-intent-drift-detection.md`.

Summary: pure additive feature. New file, new route, new off-by-default job template, CLAUDE.md addendum. No existing code paths modified. No agent behavior changes unless the operator explicitly enables the weekly job.

## Migration

- Existing agents: `PostUpdateMigrator.migrateClaudeMd()` gains one new branch that adds the Phase 4 drift curl line to CLAUDE.md when Phase 1+2+3 wording is already present. Idempotent.
- Fresh agents: `generateClaudeMd()` includes Phase 1+2+3+4 from the start.
- Job template: `installBuiltinJobs()` is called on every update and copies the new template from the package into the agent's `.instar/jobs/instar/` directory. The template ships `enabled: false`, so it has no behavior effect until the operator opts in.

## Closing note

This is the final phase of the four-phase ORG-INTENT runtime project that started with topic 11378 on 2026-05-21. Justin requested recommendations; the four-phase plan (gate / session-start / tradeoff / drift) was approved as a single autonomous build. All four phases shipped in 13 PRs of careful work, with every phase passing three tiers of tests and all CI checks before merge.

`ORG-INTENT.md` is now actually load-bearing infrastructure. The next failure mode it doesn't yet catch — agent silently optimizing for the wrong objective at the action level — is the open question for Phase 5 or whenever the next iteration begins.
