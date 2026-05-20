# Convergence Report — instar setup --framework + wizard launch (PR 3+4 of 4)

## ELI10 Overview

`instar setup` used to demand Claude Code and exit if it wasn't installed.
This release makes it accept a framework choice, detect the right binary,
and spawn the wizard inside the chosen runtime. Codex-only setup works
end-to-end (including Playwright Telegram); Claude operators see identical
behavior to before.

## Original vs Converged

The audit framed this as two PRs (detection separate from launch). During
implementation, verified that shipping detection alone would leave an
intermediate state where setup recognizes the Codex flag but then crashes
trying to spawn Claude. Combined PR 3+4 into one cohesive change — same
unit-of-value but no broken middle state.

The "smallest" PR-4 variant Justin chose: framework-neutral prompt routed
through `claude -p` or `codex exec`. The wizard skill content lives in one
file; both runtimes are pointed at it via prose for Codex (no
slash-commands) and via the existing `/setup-wizard` slash-command for
Claude.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + scope-correction (PR 3+4 combine after empirical broken-intermediate-state discovery) | 0 | None |

## Manual lessons-aware findings

Engaged P1, P10 (cohesive PR), P4 (delegates to existing
checkFrameworkPrerequisite + smoke test follows), P6, L1 (audit blockers
2+3), L6/L9/L10. Scope correction documented explicitly.

## Convergence verdict

Converged at iteration 1. PR 3 and PR 4 of the original audit's four-PR
plan are combined per operator's "smallest variant" choice plus an
empirical verification that splitting would create a worse intermediate
state. End-to-end smoke test follows as task #66.

## Deviation note

Audit framing said two PRs; empirically combined into one. Documented
here and in the PR description, not silent.
