---
title: "Parent --framework intercept hotfix — ELI16"
slug: "fix-parent-framework-intercept-eli16"
parent: "fix-parent-framework-intercept.md"
---

# Parent --framework intercept hotfix — explained simply

## What broke

PR 3+4 added the framework flag to three places by mistake: the init
subcommand, the setup subcommand, and the bareword "npx instar" with no
subcommand. The CLI library treats options on the top-level program as
global — they get parsed BEFORE any subcommand sees its own flags. So
typing `instar init --framework codex-cli` had the flag swallowed by the
top-level parser; init never knew about it and defaulted to Claude.

## How we found it

Smoke test on this machine — built the package, ran the exact command a
user would run, and inspected the result. Found CLAUDE.md and .claude/
where neither should have been, and the config showed Claude was still
"enabled". Unit tests had passed because they called the install function
directly, skipping the CLI layer where the bug lived.

## The fix

One line: remove the framework option from the top-level program. The
two subcommands keep it. Comment added next to the place where it used to
be, explaining why it's not there, so the next person editing this code
doesn't put it back. For the bareword path, use `instar setup --framework
codex-cli` instead — same result, no interception.

## Why not add a unit test

The bug is structural — about how a CLI library inherits options between
levels. A mock of that library would test whatever inheritance the test
author chose to mock, which isn't the real thing. The smoke test on a
freshly-built binary is the regression catcher. The comment at the call
site is the secondary defense.
