# Convergence Report — Real enabledFrameworks field + migrator framework gate

## ELI10 Overview

A migrator step sets up Claude-only files even for non-Claude agents. The
audit said "add a skip-if-not-Claude check," but the setting that check needed
never actually existed, so the check would have been a no-op. This change
makes the setting a real config option first, then adds one proven gate.

## Original vs Converged

The audit's framing ("wrap legacy steps in enabledFrameworks guards") was
inert as written — verified by grepping: `enabledFrameworks` was read in one
place defensively but was never an InstarConfig field, never settable, always
undefined. Converged scope: make the field real + a single-source helper +
DRY the duplicate inline logic + one fully-tested guarded step that proves the
gate is reachable. Sweeping all 49 `.claude/` refs in one PR was explicitly
rejected as regression-prone; the helper lets remaining steps adopt the gate
incrementally.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + direct code verification (inert-guard catch) | 0 | None |

## Manual lessons-aware findings

Engaged P1, P4 (6 cases incl. reachability + negative side), P6
(parity-renderings regression green after DRY refactor), P10, L1-equivalent
(framing corrected — avoided shipping theater), L6/L9/L10. No contradictions.

## Convergence verdict

Converged at iteration 1. The key value is catching that the audit's fix
would have been inert and shipping the real mechanism instead, with tests
that specifically prove the gate triggers. Fifth of the v1.0.9–v1.0.14
series.

## Deviation note

Autonomous-mode pre-authorization. Scope materially corrected from the
audit's framing after code verification — the headline of this PR is "make
the guard real, not decorative."
