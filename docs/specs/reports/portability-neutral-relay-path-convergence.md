# Convergence Report — Framework-neutral telegram-reply path

## ELI10 Overview

The script an agent uses to reply on Telegram only existed in the Claude-only
folder, so Codex/Gemini agents were told to run a missing script. This change
also installs it in the runtime-neutral `.instar/scripts/` folder and points
the agent's identity file there, with the old path kept as a fallback.

## Original vs Converged

Audit Gap 4 said "neutralize the relay path." Verified against code, the
infrastructure for a neutral preference already existed in the SessionStart
hook — the only missing pieces were (a) actually installing the script at the
neutral path and (b) the IdentityRenderer appendix still hardcoding the Claude
path. The converged change is precisely those two pieces, nothing broader.
The Claude SessionStart hook keeps its `.claude/scripts/` reference by design
(it only runs under Claude Code).

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + direct code verification + regression sweep | 0 | None |

## Manual lessons-aware findings

Engaged P1, P3 (Migration Parity — existing agents get the mirror on update,
idempotent), P4 (4 new + 1 updated test, regression sweep of 4 adjacent test
files), P6, P10, L1-equivalent, L6/L9/L10. No contradictions.

## Convergence verdict

Converged at iteration 1. Surgical, verified against code, regression-swept,
Migration-Parity-compliant. Second of the v1.0.9–v1.0.14 hardening series.

## Deviation note

Autonomous-mode pre-authorization. Scope tightened after code inspection: the
SessionStart-hook dual-path resolver already existed; the fix only had to make
its preferred path real and fix the one hardcoded appendix.
