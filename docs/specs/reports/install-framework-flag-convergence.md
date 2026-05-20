# Convergence Report — install --framework flag (PR 1 of 4)

## ELI10 Overview

`instar init` now takes a `--framework` flag. Default behavior unchanged.
Records the user's runtime choice in config so the rest of the install /
update pipeline (which already knows how to handle either Claude or Codex)
finally has something to read.

## Original vs Converged

The codex-only install audit identified this as blocker 1 of 4. Direct
verification on `origin/main`: `cli.ts:2270` had `--framework` only on the
`route` command, none on `init`/`setup`. Converged change adds the flag to
`init`, exposes a pure `resolveEnabledFrameworks(choice)` helper, and threads
`enabledFrameworks` through all three init paths (fresh / existing /
standalone) — which all previously omitted the field.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + 5-case unit test + 3-path config-write coverage | 0 | None |

## Manual lessons-aware findings

Engaged P1, P4, P6, P10 (3 init paths fixed), L1 (audit-driven, verified),
L6/L9/L10. No contradictions. PR 2-4 explicitly separate concerns, not
deferrals.

## Convergence verdict

Converged at iteration 1. Foundation for PRs 2-4 of the install/wizard
portability series.

## Deviation note

Operator pre-authorized autonomous-mode for the four-PR series. This PR
records the choice; PRs 2-4 act on it.
