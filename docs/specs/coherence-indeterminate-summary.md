---
title: Coherence Gate indeterminate checks are summarized honestly
review-convergence: retrospective-single-pass
approved: true
eli16-overview: coherence-indeterminate-summary.eli16.md
---

# Coherence Gate Indeterminate Checks Are Summarized Honestly

## Problem

The Coherence Gate can return a check result that is not a clean pass but also
should not block the action. The common case is `topic-project-alignment` when a
Telegram topic has no project binding yet: the gate cannot prove the action is in
the right project, so it should warn the agent to verify.

The recommendation already warns in that case, but the summary text can still
say all coherence checks passed because the top-level result was based only on
error-severity failures. That makes the machine-readable recommendation and the
human-readable summary disagree.

## Scope

- Represent an unbound-topic alignment check as `passed: null` to mean
  indeterminate.
- Keep recommendation semantics intact: errors block, warnings warn, clean
  checks proceed.
- Make the top-level `passed` flag strict: it is true only when every check has
  `passed: true`.
- Summarize counts by passed, warning, error, and indeterminate states so the
  text cannot claim all checks passed when one did not.
- Pin the path with unit, HTTP route, and full server lifecycle tests.

## Non-Goals

- Do not change topic-project binding behavior.
- Do not make unbound topics block; they remain warning-level verification
  prompts.
- Do not change deployment target, path-scope, git remote, or identity checks.
- Do not add new Coherence Gate authorities or new action policies.

## Acceptance Criteria

- A live check with an unbound topic returns a warning recommendation and a
  summary that includes an indeterminate count.
- The unbound topic check reports `passed: null`.
- A clean check still reports the existing all-passed summary.
- Error-severity failures still recommend block.
- Focused unit, integration route, and e2e lifecycle tests cover the
  indeterminate path.
