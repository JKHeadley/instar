# Convergence Report — Init renders non-Claude identity shadows

## ELI10 Overview

Different AI runtimes read their instructions from different filenames. When
you set up a new Instar agent, it only wrote the Claude Code file and nothing
for Codex or Gemini, so a non-Claude agent had no identity file until its
first server spawn. This change makes setup also write the non-Claude identity
files from the single canonical source, immediately, without touching the
Claude-specific capability document.

## Original vs Converged

Audit Gap 1 originally read as "init bypasses IdentityRenderer." Verified
against the code, the precise problem is narrower: init had zero framework
awareness and CLAUDE.md doubles as a rich capability doc (not an identity
render), so the fix is an *additive* non-Claude shadow render — not a
re-route of the existing CLAUDE.md write. The converged change reflects that
precision and explicitly defers the CLAUDE.md/identity-renderer unification to
its own audit gap (Gap 6).

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (autonomous pre-auth) + direct code verification | 0 | None |

## Manual lessons-aware findings

Engaged P1 (structural render), P4 (5-case unit test covering both decision
sides incl. the never-clobber-CLAUDE.md guarantee), P6 (suite green), P10
(both init paths fixed), L1-equivalent (audit-driven, verified against code),
L6/L9/L10 siblings. No contradictions.

## Convergence verdict

Converged at iteration 1. The fix is narrow, verified against the actual
code (not just the audit's framing), additive, idempotent, and fully tested.
First of the v1.0.9–v1.0.14 hardening series.

## Deviation note

Autonomous-mode pre-authorization. The audit's framing of Gap 1 was tightened
after direct code inspection (CLAUDE.md is a dual-purpose file; the fix is
additive, not a re-route). Gap 6 (migrator/renderer unification) is a distinct
audit item, not a deferral of this one.
