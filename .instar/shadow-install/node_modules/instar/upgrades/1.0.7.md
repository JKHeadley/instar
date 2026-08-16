# Upgrade Guide — v1.0.7

<!-- bump: patch -->

## What Changed

Lands the canonical Instar Design Principles + Lessons Learned index at docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md.

This is the structured catalog every Instar agent and the upcoming /spec-converge lessons-aware reviewer (8th reviewer, separate PR) consult before drafting a new spec or approving one. 10 foundational principles (Structure>Willpower, Signal-vs-Authority, Migration Parity, Testing Integrity, Agent Awareness, Zero-Failure, LLM-Supervised Execution, UX & Agent Agency, Intent Engineering, Comprehensive-First). 17 architectural lessons (AGENT.md bloat, context-death, topology check, external cross-model review, state-detection robustness, side-effects review, bug-fix evidence, active follow-through, ELI16 required, release notes in same PR, External Operation Safety, Destructive-Tool Containment, Parallel Dev Isolation, PR Review Hardening, Authorization Policy, Project Scope, Integrated-Being Ledger). 39 behavioral lessons across communication, lifecycle, testing, autonomy, and platform-specific patterns.

Sourced from CLAUDE.md Standards, 45 .instar/memory/feedback_*.md entries, docs/specs/ (TESTING-INTEGRITY-SPEC, EXTERNAL-OPERATION-SAFETY-SPEC, COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC, PARALLEL-DEV-ISOLATION-SPEC, PR-REVIEW-HARDENING-SPEC, AUTHORIZATION-POLICY-SPEC, PROJECT-SCOPE-SPEC, INTENT-ENGINEERING-SPEC, integrated-being-ledger-v2), docs/UX-AND-AGENT-AGENCY-STANDARD.md, docs/LLM-SUPERVISED-EXECUTION.md, docs/E2E-TESTING-STANDARD.md, docs/signal-vs-authority.md, and the Echo AGENT.md + USER.md identity files.

Compiled in response to a real backtrack: the conversational-action primitive draft inlined a catalog block into AGENT.md, violating three already-built defenses against AGENT.md bloat (ContextHierarchy, Playbook, Self-Knowledge Tree) plus the Structure-over-Willpower principle. The compromise to use abbreviated convergence under hybrid-C pre-authorization made the failure structural — the "self-verify against foundational specs" step is circular when the same author writes both the spec and the foundational reference. This index closes that gap by giving the lessons-aware reviewer (next PR) a single source of truth to check against.

## What to Tell Your User

- "The full list of every Instar principle, standard, and lesson is now in one place. The spec-converge reviewer will read it before approving any new spec, so we stop forgetting hard-earned lessons every time we design something new."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Canonical principles + lessons index | Read docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md before drafting any new spec. Cite engaged principles in spec frontmatter under lessons-engaged. |
| Lookup by category | Part 1 = principles (P1-P10), Part 2 = architectural lessons (L1-L17), Part 3 = behavioral lessons (B1-B39). |
| Maintenance pattern | Append-only catalog; old lessons stay even after infrastructure absorbs them, because new contributors need the why. |

## Deferred (Tracked Follow-ups)

- Lessons-aware reviewer (8th /spec-converge reviewer that consumes this index) — separate PR, next.
- Re-audit of 6 already-merged PRs (#252-#255 + foundationals) using the new reviewer; amendment PRs for critical findings (Hook stamp vs Migration Parity §4, Sentinel ship-order vs backfill).
- Migration Parity backfills across five primitives that deferred their PostUpdateMigrator entries.
