# Convergence Report — Shadow capability mirror (Gap 6 minimal shim)

## ELI10 Overview

Claude Code agents got both identity and "what you can do" sections in their
big instructions file. Codex/Gemini agents got identity (from an earlier
patch) but no capability sections. This adds a small mirror that copies the
capability sections directly from the freshly-updated CLAUDE.md into
AGENTS.md/GEMINI.md when those files exist — sections themselves are never
duplicated in source code, so the two cannot drift.

## Original vs Converged

Audit Gap 6 said "unify migrateClaudeMd with IdentityRenderer." Verified
against the code, that framing conflates identity (canonical-to-shadow
render) with capability instructions (rich per-section content). After
presenting four grounded options, the operator explicitly chose the
minimal-shim approach — a sibling migrator that mirrors the SAME sections
without re-architecting CLAUDE.md's role. Sections are sliced from the live
CLAUDE.md at migration time rather than extracted into a shared source array
(a deliberately rejected 360-line refactor).

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + operator decision via AskUserQuestion + 6-case test | 0 | None |

## Manual lessons-aware findings

Engaged P1, P4 (6 cases incl. both decision sides), P6, Trust-Verify-Improve
(bodies copied not duplicated), L1-equivalent (framing corrected),
L6/L9/L10. No contradictions. Scope explicitly bounded by operator decision.

## Convergence verdict

Converged at iteration 1. Operator-chosen scope, no fabrication, source-of-
truth preserved (CLAUDE.md is the live source the shim slices from).
Seventh shipped of the v1.0.9–v1.0.14 series (1.0.14) — the final code gap.
Closes the v1.0.0 cross-framework portability audit at 6/6.

## Deviation note

Operator explicitly chose the minimal-shim option from a four-option
AskUserQuestion. The literal-audit option ("unify with IdentityRenderer")
was acknowledged as conflating two different documents and was rejected by
the operator with the agent's concurrence.
