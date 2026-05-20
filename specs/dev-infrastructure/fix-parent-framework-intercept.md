---
title: "Hotfix: parent-level --framework option intercepted subcommand flag"
slug: "fix-parent-framework-intercept"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "fix-parent-framework-intercept.eli16.md"
review-convergence: "2026-05-20T04:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-20T04:00:00Z"
review-report: "docs/specs/reports/fix-parent-framework-intercept-convergence.md"
approved: true
approved-by: "Justin (autonomous-mode hotfix on the in-flight install/wizard portability arc; verified by smoke test on this machine)"
approved-date: "2026-05-20"
approval-note: "Smoke test caught the bug; one-line fix; ship immediately."
lessons-engaged:
  - "L1-equivalent (smoke-test-driven): unit tests passed because they called initProject directly; real CLI invocation failed because the parent program's option intercepted the flag. End-to-end verification catches what unit tests miss."
  - "P4 (Testing Integrity): smoke test added to the verification chain; documented for future regression catching."
  - "P10 (Comprehensive-First): full fix in one PR — code change + smoke confirmation."
---

# Hotfix: parent-level --framework intercepted subcommand flag

## Problem

After PR 3+4 merged (v1.0.17), the end-to-end smoke test on this machine
ran `node dist/cli.js init smoke-codex --framework codex-cli --standalone`
and found:

- `enabledFrameworks: ['claude-code']` (wrong — should be codex-cli)
- `.claude/` directory present (wrong — should be absent)
- `CLAUDE.md` present (wrong — should be absent)
- `AGENTS.md` also present (correct — produced unconditionally by Gap 1)

The CLI passed the wrong opts to `initProject`. Unit test from PR 2 passed
because it called `initProject` directly with `{framework: 'codex-cli'}` —
bypassing the CLI layer.

## Root cause

PR 3+4 added `--framework` to **three** places in `cli.ts`:
1. The `init` subcommand (correct).
2. The `setup` subcommand (correct).
3. The **bareword** (`npx instar` with no subcommand) at program level.

Commander treats program-level options as global. When invoked with a
subcommand, the program-level option parser still runs and consumes any
matching args before the subcommand parser sees them. So
`instar init --framework codex-cli` had its flag consumed by the
program-level parser; the init action handler received `opts` with no
`framework` field; `resolveEnabledFrameworks(undefined)` returned the
default `['claude-code']`.

Smoke-test discovered this in seconds; the unit tests couldn't because
they bypassed the CLI entry point.

## Fix

Remove the `--framework` option from the bareword command in `cli.ts`.
The two subcommands keep it. To request Codex from the bareword path,
operators use `instar setup --framework codex-cli` explicitly. (Or any
explicit subcommand — they all work.)

Added a comment at the call site documenting why the option is NOT
defined here, so the next person editing this file doesn't reintroduce
it.

## Why no test was added beyond the smoke test

The bug is in the structure of commander's option inheritance. A unit
test mocking commander would not catch a future re-introduction (since
the mock would have whatever inheritance semantics the test author
chose). The fix is by-comment: the explanation lives next to the call
site. The end-to-end smoke test (task #66, this same session) is the
real regression catcher and remains the verification surface.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| L1-equivalent (smoke-test discipline) | ✓ unit tests passed; only the real CLI invocation caught it. Documented in convergence report. |
| P4 Testing Integrity | ✓ smoke test is the verification surface; comment-at-call-site prevents reintroduction |
| P6 Zero-Failure | ✓ suite green; smoke now correct |
| L6/L9/L10 | ✓ siblings |

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/cli.ts` — remove the parent-level `--framework` option; explanatory comment.
3. `upgrades/NEXT.md` (v1.0.18, hotfix appended to combined release notes).
4. `upgrades/side-effects/feat-fix-parent-framework-intercept.md`.
