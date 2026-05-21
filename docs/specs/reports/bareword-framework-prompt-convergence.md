# Convergence Report — Bareword framework prompt

## ELI10 Overview

`npx instar` used to default to Claude Code silently. Now it asks which
runtime the user wants when stdin is a TTY. Skips the question when only
one runtime is installed. Pipes/CI keep their current default.

## Original vs Converged

Justin's "Yes please" to a small follow-up PR after the install/wizard
arc's parent-option hotfix (#276) left the bareword without a
`--framework` discovery path. Converged change is a 15-line runtime
prompt plus a 4-case decision-helper unit test; doesn't reintroduce the
commander parent-option interception because it's not a CLI flag.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + 4-case unit test | 0 | None |

## Manual lessons-aware findings

Engaged P1 (runtime prompt vs doc), P4 (4-case test on the pure decision
function), P6 (suite green), P10 (closes the bareword gap completely),
L1-equivalent (closes the UX gap from #276), L6/L9/L10 siblings. No
contradictions.

## Convergence verdict

Converged at iteration 1. Bareword UX is now whole. Ships v1.1.4
alongside the test-env isolation hardening from PR #286.

## Deviation note

Operator-approved (explicit "Yes please") small follow-up to close the
final UX gap from the install/wizard arc. End-to-end readline
interaction verified by Justin's manual run on his machine after merge.
