# Convergence Report — Framework-aware Threadline MCP registration

## ELI10 Overview

When an agent joins the agent-to-agent network it advertises tools. Setup only
told Claude Code; a Codex agent had the connection but no usable tools. This
adds Codex registration too, using Codex's real config format (verified, not
guessed), only when Codex is installed.

## Original vs Converged

Audit Gap 2 ("ThreadlineBootstrap framework-aware MCP registration") was
initially flagged as blocked on an external Codex spec. Per Justin's
direction, empirical inspection of the live ~/.codex/ plus our own codebase
docs gave the exact format. Converged: reuse the existing tested
OpenAiCodexMcpToolRegistry rather than hand-roll TOML, gate on ~/.codex/
presence, keep both Claude blocks byte-identical.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + empirical ~/.codex/ + codebase-doc cross-check + regression | 0 | None |

## Manual lessons-aware findings

Engaged P1, P4 (4 cases incl. idempotency + operator-content preservation),
P6, P10 (registry reuse, no duplication), Trust-Verify-Improve (format
verified live + in-codebase), L6/L9/L10. No contradictions. No fabrication.

## Convergence verdict

Converged at iteration 1. The final code-level portability gap. Empirically
grounded, reuses a tested writer, default-safe (gated on Codex presence).
Sixth shipped of the v1.0.9–v1.0.14 series (1.0.13). Gap 6 (migrator/identity
unification) intentionally remains for operator architecture review.

## Deviation note

Autonomous-mode pre-authorization. Second "external-spec-unknown" resolved by
empirical inspection per Justin's earlier correction, not deferred or
fabricated. Gap 6 is the only remaining item and is a genuine design
decision, not a deferral of doable work.
