# Convergence Report — Welcome banner framework-aware

## ELI10 Overview

When you pick "Codex CLI" at the runtime prompt during install, the
wizard's welcome banner still said "Instar runs Claude Code…". The
banner was hardcoded and ignored the framework choice. This PR
makes it derive from the resolved framework value — Codex installs
see "Codex CLI", Claude installs see "Claude Code", with the
matching sandbox-bypass flag for each.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin         | 1                 | banner branches on framework |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Banner hardcoded "Claude Code" + Claude sandbox flag.**

- Severity: low cosmetic but trust-eroding (user picked Codex,
  banner said Claude).
- Resolution: two derived local consts (`runtimeLabel`,
  `sandboxFlag`) feed a template-string console.log.

## Convergence verdict

Converged at iteration 2. One-line replacement + two consts. 4
unit tests pin both branches.
