# Convergence Report — Lessons-aware reviewer

## ELI10 Overview

The `/spec-converge` skill had seven reviewers (four perspective-based internal + three external models). None was tasked with "does this spec contradict a documented Instar lesson?" That gap produced a chain of backtracks: the conversational-action primitive draft inlining a catalog into AGENT.md (violated three already-built bloat defenses), the Hook primitive resurrecting the install-if-missing wedge for built-in hooks, the FrameworkParitySentinel shipping wiring before backfill migrations, the Testing Integrity standard being waived as a pattern.

This PR adds an eighth reviewer whose only job is to check specs against the canonical principles + lessons index (just merged via PR #257). It catches both direct contradictions and missing engagement with applicable lessons.

The bootstrap exception: this spec ships the reviewer itself, so the reviewer can't run through itself. A manual lessons-aware check is documented in the spec body against the just-merged index — same bootstrap pattern `/spec-converge` used when first introduced.

## Original vs Converged

This spec ships in one iteration because the design space is small and the failure mode is already documented in detail (`feedback_spec_converge_pre_auth_circular`). The major design decisions:

1. **Reviewer-template-only enforcement in v0.1, deterministic script check deferred to v0.2.** The prompt-level enforcement ("the SKILL.md says it MUST run") catches the same failure mode the script-level check would catch; the script check is a defense-in-depth deferral, not a recurrence-risking one.

2. **Bootstrap exception openly documented.** Same shape as `/spec-converge` itself when first introduced. Manual lessons-check applied in the spec body as a transparent substitute for the automated reviewer run.

3. **Per-agent lesson loading.** The reviewer template loads both the canonical `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (universal, ships with Instar) AND the running agent's `.instar/memory/feedback_*.md` files (per-agent supplementary). Both are needed; neither is sufficient alone.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (bootstrap exception — reviewer cannot run through itself) | 0 contradictions; 2 minor deferrals (P4 integration test, P10 convergence-tag script check) both with explicit non-recurrence-risk justification | None |

## Manual lessons-aware findings

See the `lessons-engaged:` frontmatter and the bootstrap exception section in the spec body. Every Part 1 principle (P1-P10) and every relevant Part 2 architectural lesson was walked. No contradictions. Two deferrals documented with non-recurrence-risk justification per P10.

## Convergence verdict

Converged at iteration 1 under bootstrap exception. The lessons-aware reviewer ships with the structural enforcement (SKILL.md prompt) sufficient to catch the failure mode it was designed to prevent. v0.2 adds defense-in-depth via deterministic script check.

## Deviation note

Bootstrap exception — this is the first ship of the reviewer infrastructure, so the reviewer cannot review itself. Manual lessons-check applied transparently in the spec body. Future skill changes will go through the lessons-aware reviewer (now structural).
