# Convergence Report — parent --framework intercept hotfix

## ELI10 Overview

The framework flag I added to the install/wizard arc was being silently
dropped on the most common invocation path (`instar init --framework
codex-cli`) because Commander's program-level options got first crack at
the args. Smoke test caught it; one-line code fix; comment-at-call-site
prevents reintroduction.

## Original vs Converged

PR 3+4 added the flag to three places (init, setup, bareword). The
program-level definition intercepted subcommand invocations. Converged
fix removes the program-level definition; bareword users pick a framework
by typing `instar setup --framework codex-cli` explicitly.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Smoke test on this machine + manual lessons-check | The CLI bug itself, found by the smoke test | None |

## Manual lessons-aware findings

The key lesson: unit tests bypassed the CLI layer where the bug lived.
Smoke testing on a real binary is the regression catcher. The convergence
report documents that explicitly so the lesson outlives this PR. P4
addressed by adding a comment-at-call-site (the smoke test itself is the
verification surface — saving the comment makes reintroduction visible to
the next editor).

## Convergence verdict

Converged at iteration 1. Smoke verified: `instar init --framework
codex-cli --standalone` now produces `enabledFrameworks: ['codex-cli']`,
no CLAUDE.md, no .claude/, AGENTS.md present. The install/wizard
portability arc is now actually functional end-to-end.

## Deviation note

Operator pre-authorized autonomous-mode for the install/wizard arc. This
hotfix is part of that arc — caught by the same arc's smoke test step,
fixed inline. Documented here so the smoke-test-driven debugging is
durable knowledge.
